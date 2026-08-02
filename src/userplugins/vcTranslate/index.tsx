import { Logger } from "@utils/Logger";
import definePlugin, { PluginNative } from "@utils/types";
import { ChannelStore, FluxDispatcher, MessageStore, React, Toasts, UserStore } from "@webpack/common";
import type { Message } from "@vencord/discord-types";

import { createBatcher, type Batcher } from "./batcher";
import { isChannelEnabled, loadEnabledChannels, toggleChannel } from "./channels";
import settings from "./settings";
import { onSettingsChanged } from "./settingsBridge";
import { shouldSkip } from "./skip";
import {
    getTranslation, invalidateMessage, makeKey,
    setTranslation, subscribe, type StoredTranslation
} from "./store";
import { ENGINE_CAPS, type EngineId, type PendingMessage } from "./types";

const Native = VencordNative.pluginHelpers.VcTranslate as PluginNative<typeof import("./native")>;
const logger = new Logger("VcTranslate");

let batcher: Batcher | null = null;
let pausedUntil = 0;
let sessionFallback = false;   // set when Claude is unusable this session

// Ids currently queued in the batcher or awaiting a translateBatch response.
// getTranslation() alone can't tell "in flight" apart from "never
// requested" -- a message is a cache miss for the WHOLE round trip (700ms
// debounce plus several seconds of network for Claude), not just briefly.
// Populated wherever a message is handed to batcher.add(), and drained in
// onFlush once that request settles (success, failure, or stranded by a
// rebuild) so it becomes retryable again.
const inFlight = new Set<string>();

// Bumped on every rebuildBatcher(). Each onFlush closure captures the
// generation it was created under; if a response lands after a later
// rebuild has already happened (settings changed mid-flight, or a Claude
// auth failure triggered the Google fallback), the closure's `engine` is
// stale and writing under it would land under a key nobody reads (or
// clobber the new engine's cache with a translation from the old one).
let batcherGeneration = 0;

/** The engine actually in use — may differ from the configured one. */
function effectiveEngine(): EngineId {
    const configured = settings.store.engine as EngineId;
    if (configured !== "claude") return configured;
    if (sessionFallback || settings.store.anthropicApiKey.trim() === "") return "google";
    return "claude";
}

function channelActive(channelId: string): boolean {
    return settings.store.globalAuto || isChannelEnabled(channelId);
}

function fallBackToGoogle(reason: string) {
    if (sessionFallback) return;   // only announce once
    sessionFallback = true;
    Toasts.show({
        id: Toasts.genId(),
        type: Toasts.Type.FAILURE,
        message: `VcTranslate: ${reason}. Using Google for this session.`
    });
    rebuildBatcher();
}

function rebuildBatcher() {
    // Anything still sitting in the current debounce window would otherwise
    // be lost when dispose() clears it below — no entry, no marker, no
    // retry. These messages didn't fail; the settings just changed under
    // them, so re-queue them into the new batcher instead of dropping or
    // failing them. Must happen BEFORE the generation bump and dispose.
    const orphaned = batcher?.drainPending() ?? [];

    const engine = effectiveEngine();
    batcherGeneration++;
    const myGeneration = batcherGeneration;
    batcher?.dispose();

    const markAllFailed = (req: { messages: { id: string }[]; targetLang: string; }) => {
        for (const m of req.messages) {
            setTranslation(makeKey(m.id, req.targetLang, engine), { failed: true });
        }
    };

    const newBatcher = createBatcher({
        debounceMs: 700,
        maxBatch: 10,
        contextSize: 8,
        supportsContext: ENGINE_CAPS[engine].supportsContext,
        targetLang: settings.store.targetLang,
        onFlush: async req => {
            // Superseded by a later rebuild (settings changed, or a fallback
            // fired) before this flush even started — this closure's `engine`
            // no longer matches reality, so just drop it rather than write
            // under a stale key. Still release these ids first: a batch
            // stranded here never reaches the finally below, so without this
            // they'd stay "in flight" forever and catch-up could never retry
            // them.
            if (myGeneration !== batcherGeneration) {
                for (const m of req.messages) inFlight.delete(m.id);
                return;
            }

            if (Date.now() < pausedUntil) {
                // The queue was already spliced out of the batcher before
                // onFlush ran, so if we silently return here these messages
                // are gone forever: no entry, no marker, no retry. Mark them
                // failed instead so the accessory shows ⚠ and catch-up can
                // retry later. This path never sends a request, so release
                // the ids here rather than waiting on the finally below.
                markAllFailed(req);
                for (const m of req.messages) inFlight.delete(m.id);
                return;
            }

            let res;
            try {
                res = await Native.translateBatch(
                    engine,
                    settings.store.anthropicApiKey,
                    JSON.stringify(req)
                );
            } catch {
                // Re-check here too: a rebuild during the in-flight call means
                // this batch's engine key is stale, so writing markers would
                // land under a key nothing reads — and could clobber a valid
                // cached entry for the same id under the OLD engine.
                if (myGeneration !== batcherGeneration) return;
                // IPC-level rejection (onFlush is void-returning and invoked
                // un-awaited, so an unhandled rejection here would otherwise
                // just vanish the batch with no marker).
                markAllFailed(req);
                return;
            } finally {
                // Fires once the round trip has actually settled (success OR
                // rejection), which is the earliest point these ids are safe
                // to retry — not when they were queued, and not only on the
                // happy path.
                for (const m of req.messages) inFlight.delete(m.id);
            }

            // THE race this guard exists for: rebuildBatcher() can run WHILE
            // the line above is awaiting the network round trip (a settings
            // change, or a Claude 401 triggering fallBackToGoogle mid-flight).
            // The check above this await only catches a flush that was already
            // stale before it started — it cannot catch one that went stale
            // during the await, because it isn't re-evaluated after control
            // resumes. Re-check here, before any write, so a superseded
            // response is dropped instead of landing under the old engine's
            // key (or worse, clobbering the new engine's in-progress results).
            if (myGeneration !== batcherGeneration) return;

            if (!res.ok) {
                if (res.retryAfterMs) pausedUntil = Date.now() + res.retryAfterMs;

                // Always mark this batch's messages as failed on a request-level
                // error, regardless of cause — an auth failure must not leave
                // them silently unresolved just because it ALSO triggers a
                // session fallback.
                markAllFailed(req);

                // An auth failure means the key is wrong, not that the network
                // blipped — retrying it every batch would be pure noise, so
                // fall back to Google for the rest of the session IN ADDITION
                // to (not instead of) marking this batch failed.
                if (engine === "claude" && /\b40[13]\b/.test(res.error)) {
                    fallBackToGoogle("Claude rejected the API key");
                }
                return;
            }

            for (const r of res.results) {
                if ("failed" in r) {
                    setTranslation(makeKey(r.id, req.targetLang, engine), { failed: true });
                    continue;
                }
                if (r.skip) continue;
                setTranslation(
                    makeKey(r.id, req.targetLang, engine),
                    { lang: r.lang, text: r.text }
                );
            }
        }
    });

    batcher = newBatcher;
    // Retry the orphaned messages under the new settings/engine, rather than
    // marking them failed — nothing about THEM failed, the settings changed.
    for (const m of orphaned) newBatcher.add(m);
}

function onMessageCreate({ message, optimistic }: { message: Message; optimistic?: boolean; }) {
    if (optimistic || !message?.id) return;
    if (!channelActive(message.channel_id)) return;

    const pending: PendingMessage = {
        id: message.id,
        author: message.author?.username ?? "unknown",
        text: message.content ?? "",
        channelId: message.channel_id
    };

    const isOwn = message.author?.id === UserStore.getCurrentUser()?.id;

    // Skipped messages still shape the conversation, so they become context.
    if (shouldSkip(pending.text, isOwn)) batcher?.recordContext(pending);
    else {
        inFlight.add(pending.id);
        batcher?.add(pending);
    }
}

function onMessageUpdate({ message }: { message: Message; }) {
    if (message?.id) invalidateMessage(message.id);
}

function catchUp(channelId: string) {
    if (!channelActive(channelId)) return;

    const count = settings.store.catchUpCount;
    if (count <= 0) return;

    const store = MessageStore.getMessages(channelId);
    if (!store || typeof store.toArray !== "function") {
        // Not necessarily an error -- a channel with no messages loaded yet
        // legitimately has nothing to iterate. But if the store or method
        // itself is gone, Discord's internals moved and we'd otherwise fail
        // silently with no way to tell "empty channel" from "broken".
        logger.warn(`MessageStore.getMessages(${channelId}) has no usable toArray(); skipping catch-up.`);
        return;
    }

    const all = store.toArray();
    const recent = all.slice(-count);
    const me = UserStore.getCurrentUser()?.id;
    const engine = effectiveEngine();

    for (const message of recent) {
        // A message already queued or awaiting a response is a cache miss
        // in getTranslation() for the whole round trip, not just briefly --
        // so a duplicate catch-up trigger (rapid channel reselection, or
        // CHANNEL_SELECT followed by LOAD_MESSAGES_SUCCESS for the same
        // channel) must not treat "no cache entry yet" as "never requested".
        if (inFlight.has(message.id)) continue;

        const key = makeKey(message.id, settings.store.targetLang, engine);
        const entry = getTranslation(key);
        if (entry && !("failed" in entry)) continue;   // retry failures, skip real translations

        const pending: PendingMessage = {
            id: message.id,
            author: message.author?.username ?? "unknown",
            text: message.content ?? "",
            channelId
        };

        // Skipped messages still shape the conversation, so they become
        // context. This also avoids re-requesting messages the server would
        // skip anyway (skip results write nothing to the store, so without
        // this check they'd be re-requested on every channel open forever).
        if (shouldSkip(pending.text, message.author?.id === me)) {
            batcher?.recordContext(pending);
        } else {
            inFlight.add(pending.id);
            batcher?.add(pending);
        }
    }
}

function onChannelSelect({ channelId }: { channelId: string; }) {
    if (channelId) catchUp(channelId);
}

// CHANNEL_SELECT fires before Discord has necessarily fetched the backlog
// of a channel not yet visited this session, so MessageStore.getMessages()
// can still be empty when catchUp() above runs -- exactly the "tab back in
// after a game" case the feature exists for. LOAD_MESSAGES_SUCCESS is
// Discord's event for "message history for this channel just landed"; it's
// confirmed as a real client event via the FluxEvents union in
// packages/discord-types/src/fluxEvents.d.ts, but no existing Vencord
// plugin subscribes to it, so its `channelId` payload field is inferred
// from MessageStore's own consistent naming (getMessages(channelId),
// isLoadingMessages(channelId)) and CHANNEL_SELECT's confirmed shape, not
// independently verified against a real dispatch.
function onLoadMessagesSuccess({ channelId }: { channelId: string; }) {
    if (channelId) catchUp(channelId);
}

function TranslationAccessory({ message }: { message: Message; }) {
    const [, forceUpdate] = React.useReducer((n: number) => n + 1, 0);

    React.useEffect(() => subscribe(forceUpdate), []);

    if (!channelActive(message.channel_id)) return null;

    const key = makeKey(message.id, settings.store.targetLang, effectiveEngine());
    const entry: StoredTranslation | undefined = getTranslation(key);
    if (!entry) return null;

    if ("failed" in entry) {
        return (
            <div style={{ fontSize: "0.8rem", opacity: 0.4, fontStyle: "italic" }}>
                ⚠ translation failed
            </div>
        );
    }

    return (
        <div style={{ fontSize: "0.9rem", opacity: 0.6, fontStyle: "italic" }}>
            ⤷ {entry.lang} · {entry.text}
        </div>
    );
}

export default definePlugin({
    name: "VcTranslate",
    description: "Automatically translates incoming messages and shows them as subtitles.",
    // This is a local userplugin — do not attribute it to a Vencord maintainer
    // via `Devs.*`. Put your own handle here.
    authors: [{ name: "surfer", id: 0n }],
    settings,

    renderMessageAccessory: props => (
        <TranslationAccessory message={props.message} />
    ),

    messagePopoverButton: {
        icon: () => <span style={{ fontSize: "1rem" }}>🌐</span>,
        render(message: Message) {
            const channel = ChannelStore.getChannel(message.channel_id);
            if (!channel) return null;

            const on = channelActive(message.channel_id);
            return {
                label: on ? "Disable auto-translate here" : "Enable auto-translate here",
                icon: () => <span style={{ fontSize: "1rem" }}>{on ? "🌐" : "🌫"}</span>,
                message,
                channel,
                onClick: async () => {
                    try {
                        const nowOn = await toggleChannel(message.channel_id);
                        if (nowOn) catchUp(message.channel_id);
                    } catch {
                        // toggleChannel rethrows on persistence failure (memory
                        // already rolled back by then) -- surface it instead of
                        // leaving an unhandled rejection. catchUp() is inside
                        // this try too, so a throw there can't escape unhandled
                        // either.
                        Toasts.show({
                            id: Toasts.genId(),
                            type: Toasts.Type.FAILURE,
                            message: "VcTranslate: couldn't save that toggle, try again."
                        });
                    }
                }
            };
        }
    },

    async start() {
        await loadEnabledChannels();
        rebuildBatcher();
        onSettingsChanged(rebuildBatcher);
        FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
        FluxDispatcher.subscribe("MESSAGE_UPDATE", onMessageUpdate);
        FluxDispatcher.subscribe("CHANNEL_SELECT", onChannelSelect);
        FluxDispatcher.subscribe("LOAD_MESSAGES_SUCCESS", onLoadMessagesSuccess);
    },

    stop() {
        onSettingsChanged(null);
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate);
        FluxDispatcher.unsubscribe("MESSAGE_UPDATE", onMessageUpdate);
        FluxDispatcher.unsubscribe("CHANNEL_SELECT", onChannelSelect);
        FluxDispatcher.unsubscribe("LOAD_MESSAGES_SUCCESS", onLoadMessagesSuccess);
        batcher?.dispose();
        batcher = null;
        // Anything still marked in-flight belongs to a batcher that just got
        // disposed without flushing -- without this, those ids would stay
        // permanently unretryable across a stop/start cycle.
        inFlight.clear();
        // Bump the generation so an in-flight request from before stop()
        // (e.g. a Claude call awaiting its response) fails its post-await
        // guard check in onFlush and returns before ever reaching
        // fallBackToGoogle()/rebuildBatcher() — otherwise it could resurrect
        // a batcher (and re-set sessionFallback) on an already-stopped
        // plugin. Must happen so any myGeneration captured before this
        // point can never match again.
        batcherGeneration++;
        // So toggling the plugin off/on after fixing a bad key retries
        // Claude instead of staying pinned to Google, and a stale pause
        // window doesn't carry over into the next session.
        sessionFallback = false;
        pausedUntil = 0;
    }
});
