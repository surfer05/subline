import definePlugin, { PluginNative } from "@utils/types";
import { FluxDispatcher, React, Toasts, UserStore } from "@webpack/common";
import type { Message } from "@vencord/discord-types";

import { createBatcher, type Batcher } from "./batcher";
import { isChannelEnabled, loadEnabledChannels } from "./channels";
import settings from "./settings";
import { onSettingsChanged } from "./settingsBridge";
import { shouldSkip } from "./skip";
import {
    getTranslation, invalidateMessage, makeKey,
    setTranslation, subscribe, type StoredTranslation
} from "./store";
import { ENGINE_CAPS, type EngineId, type PendingMessage } from "./types";

const Native = VencordNative.pluginHelpers.VcTranslate as PluginNative<typeof import("./native")>;

let batcher: Batcher | null = null;
let pausedUntil = 0;
let sessionFallback = false;   // set when Claude is unusable this session

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
            // under a stale key.
            if (myGeneration !== batcherGeneration) return;

            if (Date.now() < pausedUntil) {
                // The queue was already spliced out of the batcher before
                // onFlush ran, so if we silently return here these messages
                // are gone forever: no entry, no marker, no retry. Mark them
                // failed instead so the accessory shows ⚠ and catch-up can
                // retry later.
                markAllFailed(req);
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
    else batcher?.add(pending);
}

function onMessageUpdate({ message }: { message: Message; }) {
    if (message?.id) invalidateMessage(message.id);
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

    async start() {
        await loadEnabledChannels();
        rebuildBatcher();
        onSettingsChanged(rebuildBatcher);
        FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
        FluxDispatcher.subscribe("MESSAGE_UPDATE", onMessageUpdate);
    },

    stop() {
        onSettingsChanged(null);
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate);
        FluxDispatcher.unsubscribe("MESSAGE_UPDATE", onMessageUpdate);
        batcher?.dispose();
        batcher = null;
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
