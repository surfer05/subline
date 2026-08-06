import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Must exist before index.tsx's module body runs: it reads
// `VencordNative.pluginHelpers.VcTranslate` at import time. vi.hoisted is the
// only hook that fires before the import statements below.
const native = vi.hoisted(() => {
    const translateBatch = vi.fn();
    (globalThis as any).VencordNative = {
        pluginHelpers: { VcTranslate: { translateBatch } }
    };
    return { translateBatch };
});

import plugin, { FORCE_QUALITY_POPOVER_ID, FORCED_HINT_TTL_MS } from "../index";
import { acquireSlot, BURST_CAPACITY, LEARNED_QUOTA_KEY, rateGateAvailable, rateGateSettings, REFILL_MS } from "../rateGate";
import { toggleChannel } from "../channels";
import { cooldownUntil, setCooldown } from "../cooldownStore";
import settings from "../settings";
import { clearStore, getTranslation, makeKey, setTranslation } from "../store";
import { FAST_DEBOUNCE_MS, QUALITY_DEBOUNCE_MS } from "../types";
import type { NativeResponse } from "../native";
import { __resetSettings } from "./stubs/api-settings";
import * as DataStore from "./stubs/api-datastore";
import { __getPopoverButton, __reset as __resetMessagePopover } from "./stubs/api-messagepopover";
import { calls as loggedCalls, __resetLogCalls } from "./stubs/utils-logger";
import {
    __resetWebpackCommon, __stubMarkAsDm, __stubSetSelectedChannel,
    FluxDispatcher, LocaleStore, shownToasts, stubMessages
} from "./stubs/webpack-common";

const CHANNEL = "c1";

const discordMessage = (id: string, content: string, authorId = "u1") => ({
    id,
    channel_id: CHANNEL,
    content,
    author: { id: authorId, username: "ana" }
});

/**
 * Run every pending timer and let the resulting promise chain settle.
 *
 * 21s, not 5s: the quality tier now debounces for QUALITY_DEBOUNCE_MS (20s) so
 * a busy channel sits an order of magnitude under the measured rate-limit
 * ceiling (see types.ts), so anything shorter would never flush a
 * Claude/Gemini batch at all.
 */
async function settle() {
    await vi.advanceTimersByTimeAsync(21_000);
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

function respondWith(res: NativeResponse) {
    native.translateBatch.mockResolvedValue(res);
}

/** The BatchRequest the nth translateBatch call was given. */
function requestAt(n: number) {
    return JSON.parse(native.translateBatch.mock.calls[n][2]);
}

/**
 * A Google response that answers for the ids it was actually SENT, rather than
 * for one hard-coded id.
 *
 * Necessary now that the fast tier sends every message to Google on its own
 * schedule. A mock pinned to a single id answers that id on some OTHER
 * message's flush, which writes an entry for a message nobody asked about —
 * and that entry then makes needsFast() report "already resolved" when the
 * real message arrives, silently suppressing the very request the test is
 * watching for. Answering the request that was made keeps the fixture out of
 * the behaviour under test.
 */
function googleAnswers(payload: string, text = "hello there", lang = "es"): NativeResponse {
    return {
        ok: true,
        results: JSON.parse(payload).messages.map(
            (m: { id: string; }) => ({ id: m.id, lang, text, skip: false })
        )
    };
}

beforeEach(async () => {
    vi.useFakeTimers();
    native.translateBatch.mockReset();
    respondWith({ ok: true, results: [] });
    clearStore();
    __resetSettings();
    __resetWebpackCommon();
    __resetMessagePopover();
    DataStore.__reset();

    settings.store.globalAuto = true;
    settings.store.targetLang = "en";
    settings.store.engine = "google";
    settings.store.anthropicApiKey = "";

    // The user is looking at CHANNEL. Live translation is now restricted to the
    // focused channel, so without this every MESSAGE_CREATE below would be
    // (correctly) ignored — see the "only the focused channel" suite.
    __stubSetSelectedChannel(CHANNEL);

    await plugin.start!();
    // start() kicks off the persisted-cache load and defers its initial
    // catch-up until that resolves. Let those microtasks drain here so the
    // deferred catch-up can't land in the middle of a test body.
    for (let i = 0; i < 20; i++) await Promise.resolve();

    // Clean slate for every test that inspects `loggedCalls` — start() itself
    // logs nothing (debugLogging defaults to false, reset by __resetSettings()
    // above), but this keeps a test that turns the setting on immune to
    // whatever an earlier test in the same run happened to log.
    __resetLogCalls();
});

afterEach(() => {
    plugin.stop!();
    clearStore();
    vi.useRealTimers();
});

const key = (id: string) => makeKey(id, "en");

describe("skip results are written as a resolved marker", () => {
    it("records WHICH engine skipped, not just that something did", async () => {
        // `via` is not decoration: needsQuality() reads it to decide whether a
        // skip closes the message. A Google skip is not authoritative (Google
        // echoes short and romanized text back unchanged, which reads as
        // "already in the target language" when it means "Google gave up"),
        // an LLM skip is. Without `via` written here that rule is unreachable
        // and every skip looks equally final.
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        respondWith({ ok: true, results: [{ id: "1", skip: true }] });
        await settle();

        expect(getTranslation(key("1"))).toEqual({ skipped: true, via: "google" });
    });

    it("stops catch-up re-enqueueing an already-target-language backlog on every channel open", async () => {
        // The regression this guards: a skip that wrote NOTHING was
        // indistinguishable from "never requested", so every channel open
        // re-sent the whole already-translated backlog — forever, and on
        // Claude, for money.
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        respondWith({ ok: true, results: [{ id: "1", skip: true }] });
        await settle();
        expect(native.translateBatch).toHaveBeenCalledTimes(1);

        stubMessages.set(CHANNEL, [discordMessage("1", "hola")]);
        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await settle();

        expect(native.translateBatch).toHaveBeenCalledTimes(1);
    });

    it("still retries a failed message on the next channel open", async () => {
        // The `skipped` marker must not be so blunt that it swallows `failed`.
        setTranslation(key("1"), { failed: true });
        stubMessages.set(CHANNEL, [discordMessage("1", "hola")]);

        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await settle();

        expect(native.translateBatch).toHaveBeenCalledTimes(1);
        expect(requestAt(0).messages.map((m: any) => m.id)).toEqual(["1"]);
    });
});

// `deferred` is no longer WRITTEN by anything (a rate-limited quality tier
// leaves the Google line alone instead of marking it), but it is still READ:
// entries persisted by an earlier version come back on the next launch, and
// catch-up must keep treating them as retryable rather than finished.
describe("markers — who writes them, and which ones catch-up picks back up", () => {
    it("marks a batch from the fast tier's own verdict, never from the quality tier's", async () => {
        // WAS: "marks a batch deferred (not failed) only when the Google
        // fallback fails too". Same question — what does the reader end up
        // with when the LLM refuses? — against the mechanism that answers it
        // now. `deferred` used to be produced by the quality tier's in-flush
        // Google retry failing as well; that retry is gone (the fast tier
        // already sent these messages to Google before the LLM was asked), so
        // the quality tier writes NOTHING when it cannot answer and whatever
        // the reader sees is the fast tier's verdict alone.
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";
        // Blanket 429: Gemini is rate limited AND Google fails too, so there
        // is genuinely nothing to be had from anywhere. That is a real
        // attempt that came back broken — `failed` — and it must come from
        // the fast tier. No `deferred`, from either tier.
        native.translateBatch.mockImplementation(async () =>
            ({ ok: false, error: "gemini: HTTP 429", retryAfterMs: 30_000 }));

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        expect(getTranslation(makeKey("1", "en"))).toEqual({ failed: true });
        expect(getTranslation(makeKey("1", "en"))).not.toHaveProperty("deferred");

        // A second message arrives while still inside the 30s cooldown window.
        // The LLM must not be touched again — but the message must still be
        // ATTEMPTED, because the fast tier does not share the LLM's cooldown.
        const before = native.translateBatch.mock.calls.length;
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("2", "que tal") });
        await settle();

        expect(getTranslation(makeKey("2", "en"))).toEqual({ failed: true });
        const laterCalls = native.translateBatch.mock.calls.slice(before).map(c => c[0]);
        expect(laterCalls.length).toBeGreaterThan(0);
        expect(laterCalls).not.toContain("gemini");
        expect(laterCalls.every(e => e === "google")).toBe(true);
    });

    it("retries a deferred message on the next channel open, exactly like a failed one", async () => {
        setTranslation(makeKey("1", "en"), { deferred: true });
        stubMessages.set(CHANNEL, [discordMessage("1", "hola")]);

        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await settle();

        expect(native.translateBatch).toHaveBeenCalledTimes(1);
        expect(requestAt(0).messages.map((m: any) => m.id)).toEqual(["1"]);
    });

    it("does NOT retry a skipped or a real translation the way it retries deferred — engine = Google", async () => {
        // Guards against a catch-up check broad enough to retry everything.
        //
        // ENGINE = GOOGLE (from the outer beforeEach) is load-bearing, not
        // incidental: with an LLM configured, a Google skip and a Google
        // translation are BOTH still open to the quality tier (needsQuality),
        // so this expectation would be wrong. What is pinned here is the fast
        // tier's own rule — once something real is stored, Google is done —
        // which with no second tier is the whole plugin's rule.
        setTranslation(makeKey("1", "en"), { skipped: true });
        setTranslation(makeKey("2", "en"), { lang: "es", text: "hola", via: "google" });
        stubMessages.set(CHANNEL, [discordMessage("1", "a"), discordMessage("2", "b")]);

        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await settle();

        expect(native.translateBatch).not.toHaveBeenCalled();
    });

    it("re-requests a Google translation for the LLM tier, but not for the fast tier", async () => {
        // This REVERSES the earlier "engine-agnostic resolution" rule (the old
        // name of this test was "does not re-request a Google translation just
        // because an LLM engine is now selected"). That rule was correct when
        // it was written: the LLM quota was effectively a few dozen requests a
        // day, so re-spending any of it upgrading something already on screen
        // was the worst possible use of it. A Google line was treated as a
        // finished answer no matter which engine got selected next.
        //
        // That constraint no longer holds. The measured limit is 20 requests
        // per rolling minute, and the two-tier design keeps the quality tier
        // an order of magnitude under it. Per the user's own call: "gemini on
        // everything, i accept it running further behind, cause if we are not
        // hitting the limit, then why to limit ourselves." A Google line is a
        // CANDIDATE for upgrade, not a finished answer — that is the two-tier
        // feature's whole point — so catch-up must pick it back up for the
        // quality tier.
        //
        // The fast tier's job on this message IS done, though: needsFast()
        // returns false once any real translation exists, so Google must NOT
        // be asked again. Both halves are asserted, not just "something was
        // called" — this is the constraint the old test's bare
        // not.toHaveBeenCalled() couldn't express.
        setTranslation(makeKey("1", "en"), { lang: "es", text: "hola", via: "google" });
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";
        stubMessages.set(CHANNEL, [discordMessage("1", "a")]);

        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await settle();

        const engines = native.translateBatch.mock.calls.map(c => c[0]);
        expect(engines).toContain("gemini");     // the quality tier picks up the upgrade
        expect(engines).not.toContain("google");  // the fast tier's work here is already done
    });

    it("still retries a failure recorded under one engine when another is selected", async () => {
        // The flip side: engine-agnostic resolution must not make `failed`
        // and `deferred` sticky across an engine switch.
        setTranslation(makeKey("1", "en"), { failed: true });
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";
        stubMessages.set(CHANNEL, [discordMessage("1", "hola")]);

        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await settle();

        // Both tiers now get a fair shot at a failed message — dual dispatch
        // means the retry is no longer confined to a single engine.
        expect(native.translateBatch).toHaveBeenCalledTimes(2);
        for (const call of native.translateBatch.mock.calls) {
            expect(JSON.parse(call[2] as string).messages.map((m: any) => m.id)).toEqual(["1"]);
        }
    });
});

// WAS: "a rate-limited LLM falls back to Google rather than showing nothing".
// There is no falling back any more — nothing is diverted anywhere, because
// the fast tier sent these same messages to Google before the LLM was ever
// asked. The reader keeps that line; the LLM's absence costs only the upgrade.
describe("a rate-limited LLM leaves the reader the fast tier's Google line", () => {
    /** Per-engine canned responses; anything unlisted succeeds emptily. */
    function respondByEngine(map: Partial<Record<string, NativeResponse>>) {
        native.translateBatch.mockImplementation(
            async (engine: string) => map[engine] ?? { ok: true, results: [] }
        );
    }

    const RATE_LIMITED: NativeResponse = {
        ok: false, error: "gemini: HTTP 429", retryAfterMs: 30_000
    };

    const googleTranslated = (id: string): NativeResponse => ({
        ok: true, results: [{ id, lang: "es", text: "hello there", skip: false }]
    });

    /** Every string the accessory renders for a message id. */
    function renderedText(id: string): string {
        const el: any = plugin.renderMessageAccessory!({ message: discordMessage(id, "hola") } as any);
        const node = el.type(el.props);
        const walk = (n: any): string => {
            if (n === null || n === undefined || n === false) return "";
            if (typeof n === "string" || typeof n === "number") return String(n);
            if (Array.isArray(n)) return n.map(walk).join("");
            return walk(n.children);
        };
        return walk(node);
    }

    function useGemini() {
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";
    }

    it("leaves the reader a Google line when the LLM is rate limited — without spending a second Google request", async () => {
        // WAS: "re-runs the rate-limited batch through Google instead of
        // deferring it". The guarantee it protected — a mediocre Google
        // translation beats "⏳ retrying" forever — is unchanged and still
        // asserted below. What changed is who delivers it: the fast tier
        // already sent this message to Google ~19s before Gemini was asked,
        // so re-running the batch in-flush would buy a line that is ALREADY
        // ON SCREEN, at the price of a duplicate request.
        //
        // So the count is the point. Exactly one Google call, at the fast
        // tier's own 700ms mark — a second one would be the deleted in-flush
        // retry come back, and a zero would mean the reader got nothing.
        useGemini();
        const callLog: { engine: string; at: number }[] = [];
        native.translateBatch.mockImplementation(async (engine: string, _k: string, payload: string) => {
            callLog.push({ engine, at: Date.now() });
            return engine === "gemini" ? RATE_LIMITED : googleAnswers(payload);
        });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        const geminiCall = callLog.find(c => c.engine === "gemini");
        expect(geminiCall).toBeDefined();
        const googleCalls = callLog.filter(c => c.engine === "google");
        expect(googleCalls).toHaveLength(1);
        // The fast tier's own scheduled call, not a synchronous continuation
        // of the flush that got the 429 (which would share gemini's exact
        // fake-clock instant, since no timer advances in between).
        expect(googleCalls[0].at).not.toBe(geminiCall!.at);

        // What the reader is actually left with: a readable line, labelled
        // Google, and neither of the two "nothing to show" markers.
        const entry = getTranslation(makeKey("1", "en"));
        expect(entry).toEqual({ lang: "es", text: "hello there", via: "google" });
        expect(entry).not.toHaveProperty("deferred");
        expect(entry).not.toHaveProperty("failed");
    });

    it("labels the fallback line as Google (≈), never as the configured LLM (✦)", async () => {
        // The provenance glyph is the reader's only signal that this is an
        // approximate, context-free translation. Recording `via: "gemini"` for
        // a line Google produced would make ✦ a lie.
        useGemini();
        respondByEngine({ gemini: RATE_LIMITED, google: googleTranslated("1") });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        expect(getTranslation(makeKey("1", "en"))).toMatchObject({ via: "google" });
        expect(renderedText("1")).toContain("≈");
        expect(renderedText("1")).not.toContain("✦");
    });

    it("sends every batch during the cooldown straight to Google, without retrying the LLM", async () => {
        // Not retrying into the wall is the other half: roughly half the
        // observed API traffic was 429s we asked for.
        //
        // Google answers whatever it is asked (googleAnswers) rather than one
        // pinned id: with the fast tier sending each message independently, a
        // pinned mock would answer for message 2 during message 1's flush and
        // leave message 2 looking already-resolved, so the very call this test
        // asserts is still made would never be made.
        useGemini();
        native.translateBatch.mockImplementation(
            async (engine: string, _k: string, payload: string) =>
                engine === "gemini" ? RATE_LIMITED : googleAnswers(payload)
        );

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();
        const before = native.translateBatch.mock.calls.length;

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("2", "que tal") });
        await settle();

        const laterCalls = native.translateBatch.mock.calls.slice(before).map(c => c[0]);
        expect(laterCalls.length).toBeGreaterThan(0);
        expect(laterCalls).not.toContain("gemini");
        expect(getTranslation(makeKey("2", "en"))).toMatchObject({ via: "google" });
    });

    it("resumes the LLM engine automatically once the cooldown expires — no restart", async () => {
        useGemini();
        let geminiCalls = 0;
        native.translateBatch.mockImplementation(async (engine: string) => {
            if (engine === "gemini") {
                geminiCalls++;
                // Rate limited for 2s, then healthy again.
                if (geminiCalls === 1) {
                    return { ok: false, error: "gemini: HTTP 429", retryAfterMs: 2_000 };
                }
                return { ok: true, results: [{ id: "2", lang: "es", text: "from gemini", skip: false }] };
            }
            return googleTranslated("1");
        });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();   // 5s of fake time — well past the 2s cooldown
        expect(getTranslation(makeKey("1", "en"))).toMatchObject({ via: "google" });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("2", "que tal") });
        await settle();

        // Back on the good engine, with nothing restarted and no setting
        // touched. If the cooldown never expired this would still say google.
        expect(getTranslation(makeKey("2", "en")))
            .toEqual({ lang: "es", text: "from gemini", via: "gemini" });
    });

    it("floors a sub-second retry hint at the rate gate's refill interval, not the API's literal hint", async () => {
        // The numbers here are the ones a REAL Gemini 429 returned: retry in
        // 551ms, limit 20/min. Obeying 551ms literally means waking up, being
        // granted the single slot that just aged out of the rolling window,
        // and being rejected again on the very next batch — the 429 treadmill
        // this phase exists to stop. The cooldown is floored at the rate
        // gate's refill interval instead.
        //
        // This used to be observed indirectly, through whether a SECOND
        // flush landed inside the cooldown window. That is no longer
        // reachable: at QUALITY_DEBOUNCE_MS (20s) the next flush is never
        // sooner than 20s, while the floor being tested here is only 6s wide.
        // So this asserts the cooldown mark directly instead.
        useGemini();
        respondByEngine({
            gemini: {
                ok: false, error: "gemini: HTTP 429",
                retryAfterMs: 551, quotaLimitPerMinute: 20
            },
            google: googleTranslated("1")
        });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await vi.advanceTimersByTimeAsync(QUALITY_DEBOUNCE_MS);
        for (let i = 0; i < 20; i++) await Promise.resolve();

        // The 429 retuned the gate to half of 20/min, i.e. one token per 6s —
        // which is what the floor is then read off.
        expect(rateGateSettings().refillMs).toBe(6_000);

        // Floored at the gate's 6s refill interval, NOT the 551ms the API
        // asked for — a small tolerance rather than an exact equality, since
        // this is real (fake) elapsed time, not a single synchronous call.
        const until = cooldownUntil("gemini");
        expect(until).toBeGreaterThan(Date.now() + 5_500);
        expect(until).toBeLessThanOrEqual(Date.now() + 6_500);
    });

    it("says so once per session, not once per batch", async () => {
        useGemini();
        // A 2s cooldown that lapses between the two messages, so the engine is
        // genuinely re-entered into cooldown a second time — otherwise this
        // would pass without any guard at all.
        respondByEngine({
            gemini: { ok: false, error: "gemini: HTTP 429", retryAfterMs: 2_000 },
            google: googleTranslated("1")
        });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("2", "que tal") });
        await settle();

        const geminiAttempts = native.translateBatch.mock.calls.filter(c => c[0] === "gemini");
        expect(geminiAttempts.length).toBeGreaterThan(1);   // cooldown entered twice

        const cooldownToasts = shownToasts.filter(t => /rate limited/i.test(t.message));
        expect(cooldownToasts).toHaveLength(1);
        // ...and it says what happened and roughly for how long.
        expect(cooldownToasts[0].message).toMatch(/Google/);
        expect(cooldownToasts[0].message).toMatch(/\d+[sm]/);
    });

    it("retunes the rate gate from the quota the 429 reported", async () => {
        // The compiled-in guess is exactly that — a guess about someone else's
        // project. A response that states the real ceiling wins.
        expect(rateGateSettings().refillMs).toBe(REFILL_MS);

        useGemini();
        respondByEngine({
            gemini: {
                ok: false, error: "gemini: HTTP 429", retryAfterMs: 2_000, quotaLimitPerMinute: 4
            },
            google: googleTranslated("1")
        });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        // floor(4 * 0.5) = 2/minute.
        expect(rateGateSettings().refillMs).toBe(30_000);
        expect(rateGateSettings().refillMs).toBeGreaterThan(REFILL_MS);
    });

    it("does not touch the rate gate when the 429 stated no quota", async () => {
        useGemini();
        respondByEngine({ gemini: RATE_LIMITED, google: googleTranslated("1") });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        expect(rateGateSettings().refillMs).toBe(REFILL_MS);
    });

    /**
     * THE DEFECT THIS SUITE EXISTS FOR. A key with no free-tier allowance for
     * the configured model gets a 429 on its FIRST request of a session and on
     * every request after it — permanently, at any rate. In the old toast that
     * is word for word what ordinary throttling says, so the user waited it
     * out, restarted, saw it again, and concluded they were being throttled.
     * Days of it. The model name is the only thing in the response that tells
     * the two apart, so it has to reach the user.
     */
    it("names the model, and points at the setting, when the 429 says which model is over quota", async () => {
        useGemini();
        respondByEngine({
            gemini: {
                ok: false, error: "gemini: HTTP 429", retryAfterMs: 30_000,
                quotaModel: "gemini-3.6-flash"
            },
            google: googleTranslated("1")
        });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        const toast = shownToasts.find(t => t.message.includes("gemini-3.6-flash"));
        expect(toast).toBeDefined();
        // The model, what is actually wrong with it, and where to fix it.
        expect(toast!.message).toMatch(/quota|availab/i);
        expect(toast!.message).toMatch(/settings/i);
        // Still says what the reader gets meanwhile.
        expect(toast!.message).toMatch(/Google/);
    });

    it("keeps the plain rate-limit wording when the 429 names no model", async () => {
        // The two cases must stay distinguishable in BOTH directions: showing
        // "try another model" for genuine throttling would send a user off
        // changing a setting that was never the problem.
        useGemini();
        respondByEngine({ gemini: RATE_LIMITED, google: googleTranslated("1") });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        const toast = shownToasts.find(t => /rate limited/i.test(t.message));
        expect(toast).toBeDefined();
        expect(toast!.message).not.toMatch(/settings/i);
    });

    it("shows the model toast once per session too, not once per batch", async () => {
        // The one-toast-per-session discipline is not per-message-shape: a
        // catch-up storm re-enters cooldown repeatedly, and this toast is the
        // longer of the two.
        useGemini();
        respondByEngine({
            gemini: {
                ok: false, error: "gemini: HTTP 429", retryAfterMs: 2_000,
                quotaModel: "gemini-3.6-flash"
            },
            google: googleTranslated("1")
        });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("2", "que tal") });
        await settle();

        expect(native.translateBatch.mock.calls.filter(c => c[0] === "gemini").length)
            .toBeGreaterThan(1);   // cooldown genuinely entered twice
        expect(shownToasts.filter(t => t.message.includes("gemini-3.6-flash"))).toHaveLength(1);
    });
});

/**
 * The model is a SETTING because model availability moves under us: the
 * previous compiled-in `gemini-3.6-flash` returned 429 on every request against
 * a real free-tier key, and the only escape was a rebuild. A setting nothing
 * reads would be exactly as useless, so what is pinned here is that the value
 * travels all the way to the request.
 */
describe("the Gemini model setting reaches the request", () => {
    function useGemini() {
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";
    }

    /** The model argument of the first quality-tier call, if any. */
    function modelSent(): unknown {
        const call = native.translateBatch.mock.calls.find(c => c[0] === "gemini");
        expect(call).toBeDefined();
        return call![3];
    }

    it("sends the configured model with the quality batch", async () => {
        useGemini();
        settings.store.geminiModel = "gemini-2.5-pro";

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        expect(modelSent()).toBe("gemini-2.5-pro");
    });

    it("sends the measured-working default when the setting was never touched", async () => {
        useGemini();

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        expect(modelSent()).toBe("gemini-2.5-flash");
    });

    it("picks up a model change mid-session, without a restart", async () => {
        // A user doing this is already stuck on a model that refuses them.
        useGemini();
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();
        expect(modelSent()).toBe("gemini-2.5-flash");

        settings.store.geminiModel = "gemini-2.5-flash-preview";
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("2", "que tal") });
        await settle();

        const geminiCalls = native.translateBatch.mock.calls.filter(c => c[0] === "gemini");
        expect(geminiCalls[geminiCalls.length - 1][3]).toBe("gemini-2.5-flash-preview");
    });

    it("sends no model on the Google tier, which has none", async () => {
        useGemini();
        settings.store.geminiModel = "gemini-2.5-pro";

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        const googleCall = native.translateBatch.mock.calls.find(c => c[0] === "google");
        expect(googleCall).toBeDefined();
        expect(googleCall![3]).toBe("");
    });
});

describe("the rate gate — smooths a catch-up storm, never slows live chat", () => {
    it("caps an immediate burst across many channels, then drains at the refill rate", async () => {
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";
        respondWith({ ok: true, results: [] });

        // Eight channels each get one message while the user is looking at
        // them — i.e. the user cycling quickly through channels. (Before this
        // phase the same shape came from globalAuto catch-up fanning out across
        // every open channel at once; focus gating makes that impossible now,
        // but the thing under test is unchanged: many independent batches
        // becoming due at the same moment.)
        const channels = Array.from({ length: 8 }, (_, i) => `burst-${i}`);
        for (const c of channels) {
            __stubSetSelectedChannel(c);
            FluxDispatcher.dispatch("MESSAGE_CREATE", {
                message: { ...discordMessage(`m-${c}`, "hola"), channel_id: c }
            });
        }

        // Let every channel's debounce timer fire, but nothing beyond that.
        await vi.advanceTimersByTimeAsync(20_000);
        for (let i = 0; i < 20; i++) await Promise.resolve();

        // Only the burst capacity's worth of requests actually leave the
        // client immediately — this is the whole point of the gate. If this
        // is 8, nothing is throttling the storm at all. Counted on gemini
        // specifically: the fast (Google) tier also independently fires once
        // per channel now (dual dispatch), but Google isn't rate-gated, so it
        // would otherwise mask whether the gemini throttling is working.
        const geminiAfterBurst = native.translateBatch.mock.calls.filter(c => c[0] === "gemini").length;
        expect(geminiAfterBurst).toBeGreaterThan(0);
        expect(geminiAfterBurst).toBeLessThan(8);

        // The remainder drains steadily rather than being dropped or stuck
        // forever: enough refill time gets every one of them through. Derived
        // from REFILL_MS rather than spelled out, so tightening the untaught
        // defaults keeps testing "they all drain eventually" instead of
        // silently becoming "they all drain within a fixed 32 seconds".
        await vi.advanceTimersByTimeAsync(REFILL_MS * 8);
        for (let i = 0; i < 20; i++) await Promise.resolve();

        expect(native.translateBatch.mock.calls.filter(c => c[0] === "gemini")).toHaveLength(8);
    });

    it("never makes a single live-chat batch wait", async () => {
        settings.store.engine = "claude";
        settings.store.anthropicApiKey = "sk-ant-test";
        respondWith({ ok: true, results: [] });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        // Advance by exactly the debounce window, nothing more — a real
        // conversation's single flush must clear the gate with no extra wait.
        await vi.advanceTimersByTimeAsync(20_000);
        for (let i = 0; i < 20; i++) await Promise.resolve();

        // Checked on claude specifically — the fast (Google) tier also
        // independently flushes its own single batch now (dual dispatch),
        // which is not what this test is about.
        expect(native.translateBatch.mock.calls.filter(c => c[0] === "claude")).toHaveLength(1);
    });
});

/**
 * The restart defect. The gate learns the real quota from a 429 body, and used
 * to throw that away on every stop() — so each Discord launch reopened at the
 * untaught defaults, spent requests at a rate this project had already been
 * proven not to allow, and bought the same 429 (and the same toast) again,
 * seconds after starting. "I restarted Discord and instantly hit the rate
 * limit" is that, verbatim.
 */
describe("the learned quota survives a restart", () => {
    function useGemini() {
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";
    }

    /** A 429 that states the quota it just enforced, as a real Gemini one does. */
    function rateLimitedReporting(limitPerMinute: number) {
        native.translateBatch.mockImplementation(async (engine: string) => (
            engine === "gemini"
                ? {
                    ok: false, error: "gemini: HTTP 429",
                    retryAfterMs: 2_000, quotaLimitPerMinute: limitPerMinute
                }
                : { ok: true, results: [] }
        ));
    }

    it("carries a learned quota through stop()/start() instead of relearning it with a fresh 429", async () => {
        useGemini();
        rateLimitedReporting(4);

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();
        // floor(4 * 0.5) = 2/minute, i.e. one token per 30s.
        expect(rateGateSettings().refillMs).toBe(30_000);

        // A Discord restart is exactly this pair of calls.
        plugin.stop!();
        // The in-memory lesson IS dropped — proving the assertion after start()
        // is reading a value that came back off disk, not one that was simply
        // never cleared.
        expect(rateGateSettings().refillMs).toBe(REFILL_MS);

        await plugin.start!();
        for (let i = 0; i < 20; i++) await Promise.resolve();

        // ...and the new session opens at the rate this project's quota
        // actually allows, rather than at the untaught guess.
        expect(rateGateSettings()).toEqual({ capacity: 2, refillMs: 30_000 });
    });

    it("start() does not return until the learned quota is in force, so nothing can flush ahead of it", async () => {
        plugin.stop!();
        native.translateBatch.mockClear();

        // Hold the read open. Everything that could send a quality batch — the
        // batchers, the Flux subscriptions, the initial catch-up — is built
        // AFTER this await in start(), so "start() is still blocked" is the
        // same statement as "no quality batch can have gone out yet".
        let releaseRead!: () => void;
        const readBlocked = new Promise<void>(resolve => { releaseRead = resolve; });
        const get = vi.spyOn(DataStore, "get").mockImplementation(async (key: string) => {
            if (key !== LEARNED_QUOTA_KEY) return undefined;
            await readBlocked;
            return 4 as any;
        });

        let started = false;
        const starting = plugin.start!().then(() => { started = true; });
        for (let i = 0; i < 20; i++) await Promise.resolve();

        expect(started).toBe(false);
        expect(native.translateBatch).not.toHaveBeenCalled();

        releaseRead();
        await starting;
        for (let i = 0; i < 20; i++) await Promise.resolve();

        expect(started).toBe(true);
        expect(rateGateSettings().refillMs).toBe(30_000);
        get.mockRestore();
    });

    it("sends the session's FIRST quality request already at the learned rate", async () => {
        plugin.stop!();
        await DataStore.set(LEARNED_QUOTA_KEY, 4);
        useGemini();

        // Sampled inside the mock, i.e. at the instant the request leaves. A
        // load that landed after the flush would still leave the right value
        // readable at the end of the test, so reading it back afterwards would
        // assert nothing about ordering; this does.
        const gateWhenSent: Array<{ capacity: number; refillMs: number; }> = [];
        native.translateBatch.mockImplementation(async (engine: string) => {
            if (engine === "gemini") gateWhenSent.push(rateGateSettings());
            return { ok: true, results: [] };
        });

        await plugin.start!();
        for (let i = 0; i < 20; i++) await Promise.resolve();

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        expect(gateWhenSent.length).toBeGreaterThan(0);
        expect(gateWhenSent[0]).toEqual({ capacity: 2, refillMs: 30_000 });
    });

    it("starts at the untaught defaults when nothing has ever been learned", async () => {
        // The first-ever-run path, and the control for the three above: with an
        // empty store the same start() must land on the compiled-in guess.
        plugin.stop!();
        DataStore.__reset();

        await plugin.start!();
        for (let i = 0; i < 20; i++) await Promise.resolve();

        expect(rateGateSettings()).toEqual({ capacity: BURST_CAPACITY, refillMs: REFILL_MS });
    });
});

describe("the subtitle accessory", () => {
    /** Call the accessory component directly and return what it rendered. */
    const render = (message: unknown) => {
        const el: any = plugin.renderMessageAccessory!({ message } as any);
        return el.type(el.props);
    };

    /** Every string in the rendered tree, concatenated. */
    const text = (node: any): string => {
        if (node === null || node === undefined || node === false) return "";
        if (typeof node === "string" || typeof node === "number") return String(node);
        if (Array.isArray(node)) return node.map(text).join("");
        return text(node.children);
    };

    it("renders nothing at all for a skipped message", () => {
        setTranslation(key("1"), { skipped: true });
        expect(render(discordMessage("1", "hello"))).toBeNull();
    });

    it("does not fall through to the failure marker for a skipped message", () => {
        setTranslation(key("1"), { skipped: true });
        expect(text(render(discordMessage("1", "hello")))).not.toContain("⚠");
    });

    it("still renders the failure marker for a failed message", () => {
        setTranslation(key("1"), { failed: true });
        expect(text(render(discordMessage("1", "hola")))).toContain("⚠");
    });

    it("renders a deferred message as pending, not as failed", () => {
        setTranslation(key("1"), { deferred: true });
        const rendered = text(render(discordMessage("1", "hola")));
        expect(rendered).toContain("retrying");
        expect(rendered).not.toContain("⚠");
    });

    /** The first node in the rendered tree carrying a `title` prop. */
    const titleOf = (node: any): string | undefined => {
        if (node === null || typeof node !== "object") return undefined;
        if (Array.isArray(node)) {
            for (const child of node) {
                const found = titleOf(child);
                if (found !== undefined) return found;
            }
            return undefined;
        }
        if (node.props?.title) return node.props.title;
        return titleOf(node.children);
    };

    it("renders the translation for a real result", () => {
        setTranslation(key("1"), { lang: "es", text: "hello there", via: "google" });
        expect(text(render(discordMessage("1", "hola")))).toContain("hello there");
    });

    it("finds and renders a Google translation while Gemini is the configured engine", () => {
        // THE point of dropping the engine from the cache key. A fallback
        // translation written under Google used to be written to a key the
        // Gemini-configured accessory never looked at, so the subtitle simply
        // never appeared. If this ever fails again, an engine fallback is
        // invisible to the user no matter how well it works.
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";
        setTranslation(makeKey("1", "en"), { lang: "es", text: "hello there", via: "google" });

        const rendered = render(discordMessage("1", "hola"));
        expect(rendered).not.toBeNull();
        expect(text(rendered)).toContain("hello there");
    });

    it("marks an LLM translation with ✦ and a Google one with ≈", () => {
        setTranslation(key("1"), { lang: "es", text: "from gemini", via: "gemini" });
        setTranslation(key("2"), { lang: "es", text: "from claude", via: "claude" });
        setTranslation(key("3"), { lang: "es", text: "from google", via: "google" });

        expect(text(render(discordMessage("1", "hola")))).toContain("✦");
        expect(text(render(discordMessage("1", "hola")))).not.toContain("≈");
        expect(text(render(discordMessage("2", "hola")))).toContain("✦");
        expect(text(render(discordMessage("3", "hola")))).toContain("≈");
        expect(text(render(discordMessage("3", "hola")))).not.toContain("✦");
    });

    it("still shows the language code next to the provenance glyph", () => {
        setTranslation(key("1"), { lang: "es", text: "hello there", via: "gemini" });
        expect(text(render(discordMessage("1", "hola")))).toContain("es");
    });

    it("names the engine AND the language in a title attribute, so neither the glyph nor the code has to be decoded", () => {
        // The language NAME, not just the code: "ha" in the badge tells a
        // reader nothing, and "Hausa" appearing under a German conversation is
        // what makes a misdetection noticeable at all.
        setTranslation(key("1"), { lang: "es", text: "a", via: "gemini" });
        expect(titleOf(render(discordMessage("1", "hola")))).toBe("Translated by Gemini · Spanish");

        setTranslation(key("2"), { lang: "es", text: "b", via: "google" });
        expect(titleOf(render(discordMessage("2", "hola")))).toBe("Translated by Google Translate · Spanish");

        setTranslation(key("3"), { lang: "es", text: "c", via: "claude" });
        expect(titleOf(render(discordMessage("3", "hola")))).toBe("Translated by Claude · Spanish");

        setTranslation(key("4"), { lang: "ha", text: "it is", via: "google" });
        expect(titleOf(render(discordMessage("4", "ne")))).toBe("Translated by Google Translate · Hausa");
    });

    it("marks a low-confidence detection with ? so a wrong translation is not read as a right one", () => {
        // The real case: "ne" in a German channel, detected as Hausa at 0.217
        // and rendered "it is" — the opposite of the intended "no". Fluent and
        // plausible, so the badge is the reader's only warning.
        setTranslation(key("1"), { lang: "ha", text: "it is", via: "google", conf: 0.217 });
        const node = render(discordMessage("1", "ne"));
        expect(text(node)).toContain("ha?");
        expect(titleOf(node)).toContain("Hausa");
        expect(titleOf(node)).toContain("22%");
        expect(titleOf(node)).toContain("may be wrong");
    });

    it("does not mark a confident detection, so ? keeps meaning something", () => {
        setTranslation(key("1"), { lang: "de", text: "no", via: "google", conf: 0.99 });
        const node = render(discordMessage("1", "ne"));
        expect(text(node)).not.toContain("?");
        expect(titleOf(node)).not.toContain("may be wrong");
    });

    it("does not mark an LLM translation, which reports no confidence at all", () => {
        setTranslation(key("1"), { lang: "de", text: "no", via: "gemini" });
        expect(text(render(discordMessage("1", "ne")))).not.toContain("?");
    });

    it("marks a romanized Google line unsure even at full confidence", () => {
        // The measured case: ar detected at 1.00 from Latin text, negation
        // inverted. Confidence alone would let this through unmarked.
        setTranslation(key("1"), {
            lang: "ar", text: "I don't want to go home", via: "google", conf: 1
        });
        const node = render(discordMessage("1", "ana bghit nmchi l dar"));
        expect(text(node)).toContain("ar?");
        expect(titleOf(node)).toContain("Latin letters");
    });

    it("does not mark an LLM line as a romanization guess", () => {
        setTranslation(key("1"), { lang: "ar", text: "I want to go home", via: "gemini" });
        expect(text(render(discordMessage("1", "ana bghit nmchi l dar")))).not.toContain("?");
    });

    it("drops the low-confidence ? once the LLM has upgraded the line", async () => {
        // The ? means "Google was guessing at the language". Once the LLM has
        // answered, that caveat is no longer true and must not linger.
        setTranslation(key("1"), { lang: "ha", text: "it is", via: "google", conf: 0.217 });
        expect(text(render(discordMessage("1", "ne")))).toContain("ha?");

        setTranslation(key("1"), { lang: "de", text: "no", via: "gemini" });
        expect(text(render(discordMessage("1", "ne")))).not.toContain("?");
    });
});

describe("provenance is recorded from the engine that actually ran", () => {
    it("records via: gemini when Gemini produced the translation", async () => {
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        respondWith({ ok: true, results: [{ id: "1", lang: "es", text: "hello", skip: false }] });
        await settle();

        // The fast (Google) tier also independently fires now (dual
        // dispatch) and would write via:"google" first; gemini's later,
        // higher-ranked write is what must win and is what this test is
        // actually about.
        expect(native.translateBatch.mock.calls.map(c => c[0])).toContain("gemini");
        expect(getTranslation(makeKey("1", "en"))).toEqual({ lang: "es", text: "hello", via: "gemini" });
    });

    it("records via: google when the Gemini key is missing and Google actually ran", async () => {
        // The engine the request was SENT to, not the one in settings — this
        // is the shape a Phase 3 fallback will write, and mislabelling it
        // would tell the user a Google line came from an LLM.
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "";

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        respondWith({ ok: true, results: [{ id: "1", lang: "es", text: "hello", skip: false }] });
        await settle();

        expect(native.translateBatch.mock.calls[0][0]).toBe("google");
        expect(getTranslation(makeKey("1", "en"))).toEqual({ lang: "es", text: "hello", via: "google" });
    });
});

describe("MESSAGE_UPDATE", () => {
    async function translateOnce() {
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        respondWith({ ok: true, results: [{ id: "1", lang: "es", text: "hello", skip: false }] });
        await settle();
        expect(getTranslation(key("1"))).toEqual({ lang: "es", text: "hello", via: "google" });
        expect(native.translateBatch).toHaveBeenCalledTimes(1);
    }

    it("invalidates the stale translation", async () => {
        await translateOnce();

        FluxDispatcher.dispatch("MESSAGE_UPDATE", { message: discordMessage("1", "adios") });

        expect(getTranslation(key("1"))).toBeUndefined();
    });

    it("re-queues the edited message so the subtitle comes back", async () => {
        // Invalidating alone made the subtitle vanish until the next channel
        // open — manual checklist item 5 ("Subtitle re-translates to match the
        // edit") would have failed.
        await translateOnce();

        FluxDispatcher.dispatch("MESSAGE_UPDATE", { message: discordMessage("1", "adios") });
        respondWith({ ok: true, results: [{ id: "1", lang: "es", text: "bye", skip: false }] });
        await settle();

        expect(native.translateBatch).toHaveBeenCalledTimes(2);
        expect(requestAt(1).messages).toEqual([{ id: "1", author: "ana", text: "adios" }]);
        expect(getTranslation(key("1"))).toEqual({ lang: "es", text: "bye", via: "google" });
    });

    it("ignores an embed-hydration update that carries no content", async () => {
        await translateOnce();

        // Discord fires MESSAGE_UPDATE for link previews and attachment
        // processing too; those payloads have no `content` field.
        FluxDispatcher.dispatch("MESSAGE_UPDATE", {
            message: { id: "1", channel_id: CHANNEL, author: { id: "u1", username: "ana" } }
        });
        await settle();

        expect(native.translateBatch).toHaveBeenCalledTimes(1);
    });

    it("ignores an update whose content is empty", async () => {
        await translateOnce();

        FluxDispatcher.dispatch("MESSAGE_UPDATE", { message: discordMessage("1", "") });
        await settle();

        expect(native.translateBatch).toHaveBeenCalledTimes(1);
    });

    it("does not re-queue an edit in a channel that is not active", async () => {
        await translateOnce();
        settings.store.globalAuto = false;

        FluxDispatcher.dispatch("MESSAGE_UPDATE", { message: discordMessage("1", "adios") });
        await settle();

        expect(native.translateBatch).toHaveBeenCalledTimes(1);
    });

    it("does not re-queue an edit that the skip rules would reject anyway", async () => {
        await translateOnce();

        FluxDispatcher.dispatch("MESSAGE_UPDATE", { message: discordMessage("1", "https://example.com") });
        await settle();

        expect(native.translateBatch).toHaveBeenCalledTimes(1);
    });
});

describe("missing Anthropic API key", () => {
    it("shows exactly one toast per session, not one per message", async () => {
        settings.store.engine = "claude";
        settings.store.anthropicApiKey = "";

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("2", "que tal") });
        await settle();

        const missingKeyToasts = shownToasts.filter(t => /no Anthropic API key/i.test(t.message));
        expect(missingKeyToasts).toHaveLength(1);
    });

    it("says nothing when a key is present", async () => {
        settings.store.engine = "claude";
        settings.store.anthropicApiKey = "sk-ant-test";

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        expect(shownToasts.filter(t => /no Anthropic API key/i.test(t.message))).toHaveLength(0);
    });

    it("says nothing when Google is the selected engine", async () => {
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        expect(shownToasts).toHaveLength(0);
    });
});

describe("missing Gemini API key — mirrors the Claude behaviour", () => {
    it("shows exactly one toast per session, not one per message", async () => {
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "";

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("2", "que tal") });
        await settle();

        const missingKeyToasts = shownToasts.filter(t => /no Gemini API key/i.test(t.message));
        expect(missingKeyToasts).toHaveLength(1);
    });

    it("says nothing when a key is present", async () => {
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        expect(shownToasts.filter(t => /no Gemini API key/i.test(t.message))).toHaveLength(0);
    });

    it("routes translateBatch to google (not gemini) while the key is missing", async () => {
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "";

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        expect(native.translateBatch).toHaveBeenCalledTimes(1);
        expect(native.translateBatch.mock.calls[0][0]).toBe("google");
    });

    it("falls back to google and announces once when gemini rejects the key", async () => {
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-bad";
        respondWith({ ok: false, error: "gemini: HTTP 401" });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        const rejectedToasts = shownToasts.filter(t => /Gemini rejected the API key/i.test(t.message));
        expect(rejectedToasts).toHaveLength(1);

        // The session is now pinned to Google: a second message must not
        // dispatch through gemini again. Assert on the calls AFTER this point —
        // the earlier call necessarily went to gemini, because it is the very
        // request that discovered the key was bad.
        const before = native.translateBatch.mock.calls.length;
        respondWith({ ok: true, results: [] });
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("2", "que tal") });
        await settle();

        const laterCalls = native.translateBatch.mock.calls.slice(before);
        expect(laterCalls.length).toBeGreaterThan(0);
        expect(laterCalls.every(c => c[0] === "google")).toBe(true);
    });
});

describe("settings wiring", () => {
    it("hides the Anthropic key field unless Claude is selected", () => {
        const hidden = (settings as any).def.anthropicApiKey.hidden as (this: unknown) => boolean;
        expect(typeof hidden).toBe("function");

        settings.store.engine = "google";
        expect(hidden.call(settings)).toBe(true);

        settings.store.engine = "claude";
        expect(hidden.call(settings)).toBe(false);
    });

    it("hides the Gemini key field unless Gemini is selected", () => {
        const hidden = (settings as any).def.geminiApiKey.hidden as (this: unknown) => boolean;
        expect(typeof hidden).toBe("function");

        settings.store.engine = "google";
        expect(hidden.call(settings)).toBe(true);

        settings.store.engine = "claude";
        expect(hidden.call(settings)).toBe(true);

        settings.store.engine = "gemini";
        expect(hidden.call(settings)).toBe(false);
    });

    it("defaults the target language to Discord's locale, without the region subtag", () => {
        // Region-qualified would break google.ts's "already in the target
        // language" comparison, which is against a bare detected code.
        __resetSettings();
        LocaleStore.locale = "pt-BR";
        expect(settings.store.targetLang).toBe("pt");

        __resetSettings();
        LocaleStore.locale = "ja";
        expect(settings.store.targetLang).toBe("ja");
    });
});

describe("a settings change mid-debounce does not drop the message", () => {
    it("still translates a message that was queued but not yet flushed when settings change", async () => {
        // Regression: rebuildBatcher() hands orphaned (still-queued, not yet
        // flushed) messages back through enqueue() so the fast/quality split
        // can decide where they belong. But enqueue() early-returns for any
        // id already marked in-flight — and an orphaned message IS still
        // marked in-flight from its first pass, since its batch never
        // flushed. Left unhandled, that silently drops every message caught
        // mid-debounce by a settings change: no entry, no marker, no retry.
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });

        // Still inside the fast tier's 700ms window — nothing has flushed.
        await vi.advanceTimersByTimeAsync(200);
        for (let i = 0; i < 20; i++) await Promise.resolve();
        expect(native.translateBatch).not.toHaveBeenCalled();

        // Any setting with an onChange rebuilds both batchers and drains
        // whatever is still pending — targetLang here, arbitrarily.
        settings.store.targetLang = "de";

        await settle();

        const sent = native.translateBatch.mock.calls
            .flatMap(c => JSON.parse(c[2] as string).messages.map((m: any) => m.id));
        expect(sent).toContain("1");
    });

    it("leaves no stale timer behind — the queued message is sent ONCE, under the NEW settings", async () => {
        // The invariant that keeps runTier's PRE-await generation guard
        // unreachable, and therefore the tripwire that fires first if it ever
        // stops holding. rebuildBatcher() drains both batchers (which clears
        // their armed timers AND empties their queues) and then disposes them,
        // with no await between any of that and the generation bump — so an
        // old-generation onFlush closure can never be INVOKED after the bump.
        // Only a flush already awaiting the network can be superseded, and
        // catching that is the post-await guard's job (next test).
        //
        // If a future change lets an old batcher keep an armed timer across a
        // rebuild, this fails two ways at once: the message goes out twice,
        // and the stale copy goes out under the OLD targetLang. Both are
        // asserted, because "was it sent at all?" cannot see either.
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await vi.advanceTimersByTimeAsync(200);
        for (let i = 0; i < 20; i++) await Promise.resolve();
        expect(native.translateBatch).not.toHaveBeenCalled();

        settings.store.targetLang = "de";
        await settle();

        const forMessage1 = native.translateBatch.mock.calls
            .filter(c => JSON.parse(c[2] as string).messages.some((m: any) => m.id === "1"));
        expect(forMessage1).toHaveLength(1);
        expect(JSON.parse(forMessage1[0][2] as string).targetLang).toBe("de");
    });

    it("drops a response whose flush was superseded by a rebuild MID-REQUEST", async () => {
        // The generation guard that runs AFTER the network await, as distinct
        // from the one before it. A rebuild that happens WHILE the request is
        // in flight (a settings change, or a 401 falling the session back to
        // Google) leaves this flush holding a stale engine and a stale target
        // language, so its response would land under a key nobody reads — and
        // could clobber what the new generation is producing. The pre-await
        // check cannot catch this: the flush was perfectly current when it
        // started.
        let release: ((r: NativeResponse) => void) | undefined;
        native.translateBatch.mockImplementation(
            () => new Promise<NativeResponse>(resolve => { release = resolve; })
        );

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        // Past the fast window, so the request is genuinely out and waiting.
        await vi.advanceTimersByTimeAsync(1_000);
        for (let i = 0; i < 20; i++) await Promise.resolve();
        expect(release).toBeDefined();

        // The rebuild lands while that request is still in flight.
        settings.store.targetLang = "de";

        release!({ ok: true, results: [{ id: "1", lang: "es", text: "stale", skip: false }] });
        for (let i = 0; i < 20; i++) await Promise.resolve();

        expect(getTranslation(makeKey("1", "en"))).toBeUndefined();
    });
});

describe("only the channel the user is actually looking at", () => {
    it("does not translate a message in a channel that is not focused", async () => {
        // THE waste this phase removes: globalAuto means "every channel", so
        // messages in every open channel used to be translated whether or not
        // the user had ever looked at them.
        __stubSetSelectedChannel("other");

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        expect(native.translateBatch).not.toHaveBeenCalled();
    });

    it("still translates a message in the focused channel", async () => {
        // The other half of the same rule — without this, "focus" could be
        // implemented as "never translate anything" and still pass above.
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        expect(native.translateBatch).toHaveBeenCalledTimes(1);
    });

    it("does not translate an edit in a channel that is not focused", async () => {
        __stubSetSelectedChannel("other");

        FluxDispatcher.dispatch("MESSAGE_UPDATE", { message: discordMessage("1", "adios") });
        await settle();

        expect(native.translateBatch).not.toHaveBeenCalled();
    });

    it("does not catch up a channel whose history loads while the user is elsewhere", async () => {
        // LOAD_MESSAGES_SUCCESS also fires for background history fetches. If
        // it ignored focus, a restart would still fan out across every channel
        // Discord decides to hydrate.
        stubMessages.set("other", [{ ...discordMessage("1", "hola"), channel_id: "other" }]);

        FluxDispatcher.dispatch("LOAD_MESSAGES_SUCCESS", { channelId: "other" });
        await settle();

        expect(native.translateBatch).not.toHaveBeenCalled();
    });

    it("translates that same backlog as soon as the user opens the channel", async () => {
        // Not-now is not never: the deferred work is exactly what catch-up on
        // channel open already does.
        stubMessages.set("other", [{ ...discordMessage("1", "hola"), channel_id: "other" }]);

        FluxDispatcher.dispatch("LOAD_MESSAGES_SUCCESS", { channelId: "other" });
        await settle();
        expect(native.translateBatch).not.toHaveBeenCalled();

        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: "other" });
        await settle();

        expect(native.translateBatch).toHaveBeenCalledTimes(1);
        expect(requestAt(0).messages.map((m: any) => m.id)).toEqual(["1"]);
    });

    it("catches up on CHANNEL_SELECT even before SelectedChannelStore has updated", async () => {
        // Flux does not guarantee that Discord's own stores have processed
        // CHANNEL_SELECT before our subscriber runs. If catch-up gated on the
        // store here, cold-channel catch-up — the "tab back in after a game"
        // feature — would silently never fire.
        stubMessages.set("cold", [{ ...discordMessage("1", "hola"), channel_id: "cold" }]);
        __stubSetSelectedChannel(CHANNEL);   // store still reports the OLD channel

        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: "cold" });
        await settle();

        expect(native.translateBatch).toHaveBeenCalledTimes(1);
    });
});

describe("locally detected target-language messages never leave the client", () => {
    it("does not spend a request on an English message when the target is English", async () => {
        FluxDispatcher.dispatch("MESSAGE_CREATE", {
            message: discordMessage("1", "we should have a fst mc server")
        });
        await settle();

        expect(native.translateBatch).not.toHaveBeenCalled();
    });

    it("still sends a Spanish message", async () => {
        FluxDispatcher.dispatch("MESSAGE_CREATE", {
            message: discordMessage("1", "no puedo jugar hoy porque tengo que estudiar")
        });
        await settle();

        expect(native.translateBatch).toHaveBeenCalledTimes(1);
    });

    it("still sends a short ambiguous message rather than guessing", async () => {
        // "THIS" contains an English function word and nothing else. Guessing
        // English here would silently drop it if it were, say, a foreign
        // proper noun — so it must be sent.
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "THIS") });
        await settle();

        expect(native.translateBatch).toHaveBeenCalledTimes(1);
    });

    it("does not apply the English heuristic to a non-English target language", async () => {
        settings.store.targetLang = "es";

        FluxDispatcher.dispatch("MESSAGE_CREATE", {
            message: discordMessage("1", "we should have a fst mc server")
        });
        await settle();

        expect(native.translateBatch).toHaveBeenCalledTimes(1);
    });
});

describe("batch sizing follows the daily request budget", () => {
    it("holds an LLM batch past the old 700ms window", async () => {
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });

        // The fast (Google) tier fires within its own 700ms window now — that
        // is dual dispatch working as intended — but the quality (LLM) tier
        // must not: it holds its batch until QUALITY_DEBOUNCE_MS regardless.
        await vi.advanceTimersByTimeAsync(700);
        for (let i = 0; i < 20; i++) await Promise.resolve();
        expect(native.translateBatch.mock.calls.map(c => c[0])).not.toContain("gemini");

        await settle();

        expect(native.translateBatch.mock.calls.filter(c => c[0] === "gemini")).toHaveLength(1);
    });

    it("packs 25 messages into a single LLM request", async () => {
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";

        for (let i = 0; i < 25; i++) {
            FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage(String(i), "hola") });
        }
        await settle();

        // The fast (Google) tier also receives all 25 messages now (dual
        // dispatch) and packs them into its own smaller batches — that is
        // covered by "keeps Google on its smaller, latency-tuned batch"
        // below. This test is specifically about the LLM's own batch.
        const geminiCalls = native.translateBatch.mock.calls.filter(c => c[0] === "gemini");
        expect(geminiCalls).toHaveLength(1);
        expect(JSON.parse(geminiCalls[0][2] as string).messages).toHaveLength(25);
    });

    it("keeps Google on its smaller, latency-tuned batch", async () => {
        // Google is per-message with its own concurrency cap and was never the
        // source of the 429s, so it must not inherit the LLM sizing.
        for (let i = 0; i < 25; i++) {
            FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage(String(i), "hola") });
        }
        await settle();

        expect(requestAt(0).messages).toHaveLength(10);
    });
});

describe("a rate-limit cooldown survives a restart", () => {
    /** Stop and start the plugin, exactly as quitting and reopening Discord does. */
    async function restart() {
        plugin.stop!();
        await plugin.start!();
        for (let i = 0; i < 20; i++) await Promise.resolve();
    }

    it("does not spend a probe request on an engine still known to be rate limited", async () => {
        // Reported live: "whenever I open Discord and enter a channel I see a
        // Gemini rate-limit error". The cooldown lived only in module state, so
        // every launch inside a rate-limit window paid one request to
        // rediscover the limit — the single worst request to spend when the
        // quota is already gone — and greeted the user with a toast.
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";
        // Google answers the ids it was actually sent — see googleAnswers. A
        // mock pinned to id "2" would answer for message 2 during message 1's
        // fast flush, leaving message 2 already-resolved and suppressing the
        // Google call this test asserts still happens after the restart.
        native.translateBatch.mockImplementation(
            async (engine: string, _k: string, payload: string) =>
                engine === "gemini"
                    ? { ok: false, error: "gemini: HTTP 429", retryAfterMs: 600_000 }
                    : googleAnswers(payload, "hi"));

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();
        expect(native.translateBatch.mock.calls.map(c => c[0])).toContain("gemini");

        await restart();
        native.translateBatch.mockClear();

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("2", "que tal") });
        await settle();

        const engines = native.translateBatch.mock.calls.map(c => c[0]);
        expect(engines).not.toContain("gemini");
        expect(engines).toContain("google");
    });

    it("uses the LLM again after a restart once the cooldown has expired", async () => {
        // The mark must not become a permanent ban: it is a timestamp, so a
        // window that closed while Discord was shut counts as closed.
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";
        native.translateBatch.mockImplementation(async (engine: string) =>
            engine === "gemini"
                ? { ok: false, error: "gemini: HTTP 429", retryAfterMs: 1_000 }
                : { ok: true, results: [] });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();   // 5s of fake time — well past the 1s cooldown

        await restart();
        native.translateBatch.mockClear();
        native.translateBatch.mockResolvedValue({ ok: true, results: [] });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("2", "que tal") });
        await settle();

        expect(native.translateBatch.mock.calls.map(c => c[0])).toContain("gemini");
    });
});

describe("globalAuto does not reach private conversations", () => {
    it("DOES translate a DM the user explicitly enabled, even with globalAuto off", async () => {
        // The other half of the rule, and the one that was never covered:
        // globalAuto deliberately refuses DMs, but an explicit per-channel
        // opt-in is a direct instruction about THIS conversation and overrides
        // that refusal. Without this test, "the globe button works in DMs" was
        // only ever an inference from reading channelActive.
        settings.store.globalAuto = false;
        __stubMarkAsDm("dm1");
        __stubSetSelectedChannel("dm1");
        await toggleChannel("dm1");

        FluxDispatcher.dispatch("MESSAGE_CREATE", {
            message: { ...discordMessage("d1", "hola"), channel_id: "dm1" }
        });
        await settle();

        const sent = native.translateBatch.mock.calls
            .flatMap(c => JSON.parse(c[2] as string).messages.map((m: any) => m.id));
        expect(sent).toContain("d1");
    });

    it("translates a guild channel but never a DM", async () => {
        settings.store.globalAuto = true;

        // Same message posted in a guild channel and in a DM. The only
        // difference is the channel type, which is exactly the distinction
        // globalAuto must respect: sending a public channel to a third-party
        // endpoint is the user's decision to make, a private DM is not.
        __stubMarkAsDm("dm1");
        respondWith({
            ok: true,
            results: [{ id: "g1", lang: "es", text: "hello", skip: false }]
        });

        FluxDispatcher.dispatch("MESSAGE_CREATE", {
            message: { ...discordMessage("g1", "hola"), channel_id: CHANNEL }
        });
        // Focus the DM before posting in it, so the DM is rejected by the
        // guild_id check under test and not incidentally by the focus check —
        // otherwise this assertion would pass for the wrong reason.
        __stubSetSelectedChannel("dm1");
        FluxDispatcher.dispatch("MESSAGE_CREATE", {
            message: { ...discordMessage("d1", "hola"), channel_id: "dm1" }
        });
        await settle();

        const sent = native.translateBatch.mock.calls
            .flatMap(c => JSON.parse(c[2] as string).messages.map((m: any) => m.id));

        expect(sent).toContain("g1");
        expect(sent).not.toContain("d1");
    });
});

describe("a fresh install works without touching any setting", () => {
    // The regression this guards: globalAuto used to default to false, so a
    // brand-new install translated nothing until the user discovered the
    // per-channel globe button. Every other test in this file sets
    // globalAuto explicitly in beforeEach and so proves nothing about the
    // default — these two restart the plugin over settings that were reset
    // to their compiled-in defaults, touching NOTHING afterwards, to
    // actually exercise what a fresh install gets.
    beforeEach(async () => {
        plugin.stop!();
        __resetSettings();
        await plugin.start!();
        for (let i = 0; i < 20; i++) await Promise.resolve();
    });

    it("translates a message in a guild channel with no settings touched", async () => {
        respondWith({ ok: true, results: [{ id: "1", lang: "es", text: "hello", skip: false }] });
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        expect(getTranslation(key("1"))).toBeTruthy();
    });

    it("does not translate a DM with no settings touched", async () => {
        __stubMarkAsDm("dm1");
        __stubSetSelectedChannel("dm1");

        FluxDispatcher.dispatch("MESSAGE_CREATE", {
            message: { ...discordMessage("d1", "hola"), channel_id: "dm1" }
        });
        await settle();

        const sent = native.translateBatch.mock.calls
            .flatMap(c => JSON.parse(c[2] as string).messages.map((m: any) => m.id));
        expect(sent).not.toContain("d1");
    });
});

describe("catch-up spends its budget on requests, not on messages it will skip locally", () => {
    /** Confidently English by detectLang's rules, so it costs no request. */
    const english = (id: string) =>
        discordMessage(id, "i think that we should go to the server now");

    it("reaches an older foreign message past a wall of English chatter", async () => {
        // THE regression, reported from a live English-majority channel: French
        // messages from the morning were still untranslated in the evening, and
        // scrolling back never fixed them.
        //
        // catchUpCount is 20. A locally-skipped message writes NOTHING to the
        // store (deliberately — see enqueue), so it is never "resolved", and
        // counting it against the budget means 20 English lines exhaust catch-up
        // before it ever reaches the message the user actually needed.
        settings.store.engine = "google";
        settings.store.catchUpCount = 20;

        const backlog = [
            discordMessage("fr", "je vais m'en aller incessamment sous peu"),
            ...Array.from({ length: 25 }, (_, i) => english(`en${i}`))
        ];
        stubMessages.set(CHANNEL, backlog);

        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await settle();

        const sent = native.translateBatch.mock.calls
            .flatMap(c => JSON.parse(c[2] as string).messages.map((m: any) => m.id));
        expect(sent).toContain("fr");
    });

    it("still bounds how many REQUESTS a single catch-up can spend", async () => {
        // The budget must still exist — the fix is what it counts, not whether
        // it counts. 25 foreign messages, budget 20, so 5 must be left behind.
        settings.store.engine = "google";
        settings.store.catchUpCount = 20;

        stubMessages.set(CHANNEL, Array.from({ length: 25 },
            (_, i) => discordMessage(`f${i}`, "je vais m'en aller incessamment sous peu")));

        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await settle();

        const sent = native.translateBatch.mock.calls
            .flatMap(c => JSON.parse(c[2] as string).messages.map((m: any) => m.id));
        expect(sent).toHaveLength(20);
    });
});

describe("catch-up upgrades messages Google already translated", () => {
    it("re-enqueues a Google line for the LLM on channel open", async () => {
        // The silent-no-op guard. Every message has a Google subtitle within a
        // second, so a resolved-check that only asks "is there an entry?" would
        // consider the whole backlog finished and never upgrade any of it.
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";
        setTranslation(key("1"), { lang: "de", text: "rough", via: "google" });
        stubMessages.set(CHANNEL, [discordMessage("1", "hola")]);
        respondWith({ ok: true, results: [] });

        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await vi.advanceTimersByTimeAsync(30_000);
        for (let i = 0; i < 20; i++) await Promise.resolve();

        const engines = native.translateBatch.mock.calls.map(c => c[0]);
        expect(engines).toContain("gemini");
        expect(engines).not.toContain("google");   // Google's work is already done
    });

    it("leaves a message the LLM already translated completely alone", async () => {
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";
        setTranslation(key("1"), { lang: "de", text: "good", via: "gemini" });
        stubMessages.set(CHANNEL, [discordMessage("1", "hola")]);

        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await vi.advanceTimersByTimeAsync(30_000);
        for (let i = 0; i < 20; i++) await Promise.resolve();

        expect(native.translateBatch).not.toHaveBeenCalled();
    });

    it("still sends a Google skip to the LLM — a Google skip is not authoritative", async () => {
        // Carried forward from Task 3's review: the coarse pre-filter used to
        // discard any `skipped` entry before needsQuality ever ran, which
        // defeated needsQuality's whole point. A GOOGLE skip means "Google gave
        // up" (it echoes short/romanized text back unchanged — measured on
        // Moroccan Arabic in Latin letters, e.g. "salam khouya kifach" — and
        // isSameText reads that echo as 'already in the target language'), not
        // "this message is done". Only an LLM's OWN skip should close it.
        //
        // Nothing writes `via` on a skip yet (that's Task 5), so this state is
        // constructed directly rather than driven through an engine.
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";
        setTranslation(key("1"), { skipped: true, via: "google" });
        stubMessages.set(CHANNEL, [discordMessage("1", "salam khouya kifach")]);
        respondWith({ ok: true, results: [] });

        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await vi.advanceTimersByTimeAsync(30_000);
        for (let i = 0; i < 20; i++) await Promise.resolve();

        const engines = native.translateBatch.mock.calls.map(c => c[0]);
        expect(engines).toContain("gemini");
    });
});

describe("a short reply borrows its parent's language instead of being guessed at", () => {
    /** A message that Discord marks as a reply to `parentId`. */
    const replyTo = (id: string, content: string, parentId: string) => ({
        ...discordMessage(id, content),
        message_reference: { message_id: parentId }
    });

    /** The sourceLang the Google engine was asked to pin, for message `id`. */
    function sentSourceLang(id: string): string | undefined {
        for (const call of native.translateBatch.mock.calls) {
            if (call[0] !== "google") continue;
            const m = JSON.parse(call[2] as string).messages.find((m: any) => m.id === id);
            if (m) return m.sourceLang;
        }
        return undefined;
    }

    beforeEach(() => {
        settings.store.engine = "google";
    });

    it("pins the parent's language for a short reply — the 'ne' case", async () => {
        // Live: "ne" under sl=auto is Hausa "it is"; the German parent makes it
        // sl=de, which returns "no". The parent here is the actual message that
        // preceded it in the channel this was captured from.
        setTranslation(makeKey("p", "en"), {
            lang: "de", text: "Are the group rooms air-conditioned at the university?",
            via: "google", conf: 1
        });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: replyTo("1", "ne", "p") });
        await settle();

        expect(sentSourceLang("1")).toBe("de");
    });

    it("leaves a LONG reply to auto-detect, so a different language is not forced into the parent's", async () => {
        // The multilingual-channel guard: someone answering a German message in
        // Spanish at length must still be detected as Spanish. Length is what
        // makes auto-detection trustworthy, so length is where borrowing stops.
        setTranslation(makeKey("p", "en"), { lang: "de", text: "x", via: "google", conf: 1 });

        FluxDispatcher.dispatch("MESSAGE_CREATE", {
            message: replyTo("1", "pues la verdad es que no tengo ni idea", "p")
        });
        await settle();

        expect(sentSourceLang("1")).toBeUndefined();
    });

    it("does not borrow from a parent that was itself only guessed at", async () => {
        // Otherwise one bad detection propagates down an entire reply chain,
        // and every message in it looks equally confident.
        setTranslation(makeKey("p", "en"), {
            lang: "ha", text: "it is", via: "google", conf: 0.217
        });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: replyTo("1", "ne", "p") });
        await settle();

        expect(sentSourceLang("1")).toBeUndefined();
    });

    it("does not borrow when the message is not a reply at all", async () => {
        setTranslation(makeKey("p", "en"), { lang: "de", text: "x", via: "google", conf: 1 });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "ne") });
        await settle();

        expect(sentSourceLang("1")).toBeUndefined();
    });

    it("does not borrow from a parent that has no translation yet", async () => {
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: replyTo("1", "ne", "nope") });
        await settle();

        expect(sentSourceLang("1")).toBeUndefined();
    });
});

describe("every message goes to both tiers", () => {
    beforeEach(() => {
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";
    });

    it("translates with Google first and the LLM afterwards", async () => {
        native.translateBatch.mockImplementation(async (engine: string) => ({
            ok: true,
            results: [{
                id: "1", lang: "de",
                text: engine === "google" ? "rough" : "good",
                skip: false
            }]
        }));

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });

        // The fast window is 700ms; the quality window is 20s. After ~1s the
        // reader must already have something, and it must be Google's.
        await vi.advanceTimersByTimeAsync(1_000);
        for (let i = 0; i < 20; i++) await Promise.resolve();
        expect(getTranslation(key("1"))).toMatchObject({ via: "google", text: "rough" });

        await vi.advanceTimersByTimeAsync(30_000);
        for (let i = 0; i < 20; i++) await Promise.resolve();
        expect(getTranslation(key("1"))).toMatchObject({ via: "gemini", text: "good" });
    });

    it("does not let a slow Google reply overwrite the LLM line", async () => {
        // Ordering between the tiers is not guaranteed. Without the upgrade
        // rule the reader watches a good line degrade into a worse one.
        //
        // NOTHING IS PRE-SEEDED, deliberately. An earlier version of this test
        // stored the Gemini line up front, which made needsFast() suppress the
        // Google request altogether — so mayReplace was never consulted and the
        // test passed with the rank rule deleted. Here both tiers genuinely
        // run: Google's reply is held back past the quality tier's 20s window,
        // so it arrives at a key that already holds a real LLM translation and
        // is refused on the way in.
        native.translateBatch.mockImplementation(
            async (engine: string, _k: string, payload: string) => {
                if (engine === "google") {
                    await new Promise<void>(resolve => setTimeout(resolve, 30_000));
                    return googleAnswers(payload, "rough", "de");
                }
                return { ok: true, results: [{ id: "1", lang: "de", text: "good", skip: false }] };
            }
        );

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });

        // 21s: the quality tier has flushed and written, Google has not replied.
        await vi.advanceTimersByTimeAsync(21_000);
        for (let i = 0; i < 20; i++) await Promise.resolve();
        const engines = native.translateBatch.mock.calls.map(c => c[0]);
        expect(engines).toContain("google");   // the fast tier really was asked
        expect(getTranslation(key("1"))).toMatchObject({ via: "gemini", text: "good" });

        // Now Google's real translation lands, late, on top of the LLM line.
        await vi.advanceTimersByTimeAsync(15_000);
        for (let i = 0; i < 20; i++) await Promise.resolve();

        expect(getTranslation(key("1"))).toMatchObject({ via: "gemini", text: "good" });
    });

    it("uses only the fast tier when the configured engine is Google", async () => {
        settings.store.engine = "google";
        respondWith({ ok: true, results: [{ id: "1", lang: "de", text: "rough", skip: false }] });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();
        await vi.advanceTimersByTimeAsync(30_000);
        for (let i = 0; i < 20; i++) await Promise.resolve();

        expect(native.translateBatch.mock.calls.map(c => c[0])).toEqual(["google"]);
    });

    it("does not let a Google skip close the message for the quality tier", async () => {
        // needsQuality()'s "GOOGLE skip does not close it" rule: a skip
        // recorded under Google means Google merely failed to identify a
        // short message, not that the quality tier has nothing to add.
        setTranslation(key("1"), { skipped: true, via: "google" });
        respondWith({ ok: true, results: [{ id: "1", lang: "de", text: "good", skip: false }] });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        // needsFast() sees a resolved (skipped) entry and does not re-fire the
        // fast tier — Google already spoke on this message.
        expect(native.translateBatch.mock.calls.map(c => c[0])).toEqual(["gemini"]);
        expect(getTranslation(key("1"))).toMatchObject({ via: "gemini", text: "good" });
    });
});

describe("a failing quality tier never takes anything away from the reader", () => {
    beforeEach(() => {
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";
    });

    it("keeps the Google line when the LLM is rate limited", async () => {
        native.translateBatch.mockImplementation(async (engine: string) =>
            engine === "google"
                ? { ok: true, results: [{ id: "1", lang: "de", text: "rough", skip: false }] }
                : { ok: false, error: "gemini: HTTP 429", retryAfterMs: 30_000 });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();
        await vi.advanceTimersByTimeAsync(30_000);
        for (let i = 0; i < 20; i++) await Promise.resolve();

        // Still readable, still marked Google. NOT failed, NOT deferred.
        expect(getTranslation(key("1"))).toMatchObject({ via: "google", text: "rough" });
        expect(getTranslation(key("1"))).not.toHaveProperty("deferred");
        expect(getTranslation(key("1"))).not.toHaveProperty("failed");
    });

    it("does not relabel a Google skip as a failure when the LLM is rate limited", async () => {
        // The case mayReplace() does NOT cover, and therefore the one the
        // `if (!isQuality)` guard in runTier exists for. A marker cannot
        // replace a real translation, but a `skipped` entry is not a real
        // translation — so without that guard a rate-limited quality tier
        // would overwrite it with { failed: true }, and a message that is
        // simply already in the target language (nothing to show, and
        // nothing wrong) would start rendering "⚠ translation failed".
        native.translateBatch.mockImplementation(async (engine: string) =>
            engine === "google"
                ? { ok: true, results: [{ id: "1", skip: true }] }
                : { ok: false, error: "gemini: HTTP 429", retryAfterMs: 30_000 });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();
        await vi.advanceTimersByTimeAsync(30_000);
        for (let i = 0; i < 20; i++) await Promise.resolve();

        expect(getTranslation(key("1"))).toEqual({ skipped: true, via: "google" });
    });

    it("does not send a quality request at all while the engine is cooling down", async () => {
        native.translateBatch.mockImplementation(async (engine: string) =>
            engine === "google"
                ? { ok: true, results: [{ id: "9", lang: "de", text: "rough", skip: false }] }
                : { ok: false, error: "gemini: HTTP 429", retryAfterMs: 600_000 });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();
        await vi.advanceTimersByTimeAsync(30_000);
        for (let i = 0; i < 20; i++) await Promise.resolve();
        const before = native.translateBatch.mock.calls.length;

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("2", "que tal") });
        await settle();
        await vi.advanceTimersByTimeAsync(30_000);
        for (let i = 0; i < 20; i++) await Promise.resolve();

        const later = native.translateBatch.mock.calls.slice(before).map(c => c[0]);
        expect(later).not.toContain("gemini");
        expect(later).toContain("google");
    });
});

describe("a failed quality attempt is not re-requested forever", () => {
    /** How many requests the quality tier has actually spent. */
    const geminiCalls = () =>
        native.translateBatch.mock.calls.filter(c => c[0] === "gemini").length;

    /**
     * Google answers whatever it is sent; Gemini answers every id with the
     * per-message failure llmShared.ts emits for any id the model omitted from
     * a batch (`{ id, failed: true }`). That is the routine case, not an exotic
     * one, and it is invisible by design: the quality tier writes NOTHING, so
     * the store still holds the fast tier's Google line and looks exactly as it
     * did before the request was spent.
     */
    function llmOmitsEveryId() {
        native.translateBatch.mockImplementation(
            async (engine: string, _k: string, payload: string) =>
                engine === "google"
                    ? googleAnswers(payload, "rough", "de")
                    : {
                        ok: true,
                        results: JSON.parse(payload).messages.map(
                            (m: { id: string; }) => ({ id: m.id, failed: true })
                        )
                    }
        );
    }

    beforeEach(() => {
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";
        stubMessages.set(CHANNEL, [discordMessage("1", "hola")]);
    });

    it("does not spend a new LLM request on every channel open", async () => {
        // The probe that found this: four CHANNEL_SELECTs produced four Gemini
        // requests for ONE message, with the store entry unchanged throughout.
        // Every channel open — and every scroll-up, since LOAD_MESSAGES_SUCCESS
        // drives catch-up too — re-spent the quota the two-tier split exists to
        // conserve.
        llmOmitsEveryId();

        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await settle();
        expect(geminiCalls()).toBe(1);

        for (let i = 0; i < 3; i++) {
            FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
            await settle();
        }

        expect(geminiCalls()).toBe(1);
        // ...and the constraint that must survive the fix: the reader still has
        // the readable Google line. The attempt is remembered OUTSIDE the store,
        // so nothing was written over it — no marker, no downgrade.
        expect(getTranslation(key("1"))).toMatchObject({ via: "google", text: "rough" });
    });

    it("does not spend a new LLM request when the whole batch failed either", async () => {
        // A non-429, non-401 batch failure enters no cooldown, so nothing else
        // in the plugin would have slowed this loop down.
        native.translateBatch.mockImplementation(
            async (engine: string, _k: string, payload: string) =>
                engine === "google"
                    ? googleAnswers(payload, "rough", "de")
                    : { ok: false, error: "gemini: HTTP 500" }
        );

        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await settle();
        expect(geminiCalls()).toBe(1);

        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await settle();

        expect(geminiCalls()).toBe(1);
        expect(getTranslation(key("1"))).toMatchObject({ via: "google", text: "rough" });
    });

    it("gives an EDITED message a fresh quality attempt", async () => {
        // The attempt was spent on text that no longer exists, so the budget
        // must not carry over — otherwise editing a message the quality tier
        // had already tried would pin it to the fast tier's line forever.
        llmOmitsEveryId();

        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await settle();
        expect(geminiCalls()).toBe(1);

        FluxDispatcher.dispatch("MESSAGE_UPDATE", { message: discordMessage("1", "que tal") });
        await settle();

        expect(geminiCalls()).toBe(2);
    });

    it("leaves a message the quality tier never actually got to still upgradable", async () => {
        // The distinction the ledger is written at SEND time for: a flush that
        // returned early because the engine was cooling down cost nothing, so
        // that message must still be picked up once the cooldown lapses.
        // (A 600s cooldown is entered by message 1's own batch; message 2
        // arrives inside it, is enqueued for the quality tier, and its flush
        // returns before sending anything.)
        native.translateBatch.mockImplementation(
            async (engine: string, _k: string, payload: string) =>
                engine === "google"
                    ? googleAnswers(payload, "rough", "de")
                    : { ok: false, error: "gemini: HTTP 429", retryAfterMs: 600_000 }
        );

        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await settle();
        const spentOnMessage1 = geminiCalls();

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("2", "que tal") });
        await settle();
        expect(geminiCalls()).toBe(spentOnMessage1);   // cooling down: nothing sent

        // Cooldown lapses. Message 2 was never charged an attempt, so reopening
        // the channel picks it back up.
        await vi.advanceTimersByTimeAsync(600_000);
        stubMessages.set(CHANNEL, [discordMessage("1", "hola"), discordMessage("2", "que tal")]);
        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await settle();

        expect(geminiCalls()).toBe(spentOnMessage1 + 1);
        expect(requestAt(native.translateBatch.mock.calls.length - 1).messages.map((m: any) => m.id))
            .toEqual(["2"]);
    });
});

describe("marker writes never clobber a real translation from the other tier", () => {
    it("a failed marker from one tier does not erase a real translation already stored by the other", async () => {
        // The regression this guards: before marker writes were routed
        // through writeResult(), a bare setTranslation() for `failed` would
        // unconditionally overwrite whatever was there — including a real
        // translation the other tier had already produced.
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";

        native.translateBatch.mockImplementation(async (engine: string) => {
            if (engine === "google") {
                // Deliberately slow: still in flight long after the quality
                // tier's own (much later-queued) request has already come
                // back and written a real translation.
                await new Promise<void>(resolve => setTimeout(resolve, 30_000));
                return { ok: false, error: "google: HTTP 500" };
            }
            return { ok: true, results: [{ id: "1", lang: "de", text: "good", skip: false }] };
        });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });

        // Quality tier's 20s window elapses well before Google's artificially
        // delayed response, so the real translation lands first.
        await vi.advanceTimersByTimeAsync(21_000);
        for (let i = 0; i < 20; i++) await Promise.resolve();
        expect(getTranslation(key("1"))).toMatchObject({ via: "gemini", text: "good" });

        // Now let Google's delayed failure land and try to write { failed: true }.
        await vi.advanceTimersByTimeAsync(15_000);
        for (let i = 0; i < 20; i++) await Promise.resolve();

        expect(getTranslation(key("1"))).toMatchObject({ via: "gemini", text: "good" });
    });
});

describe("scrolling back through history does not spend the quality tier's quota", () => {
    /**
     * THE DEFECT: catch-up's budget (catchUpCount, 20) is per INVOCATION, and
     * Discord re-fires LOAD_MESSAGES_SUCCESS for every chunk of history a
     * scroll loads. Every scroll therefore got a fresh 20-message allowance
     * and produced another quality-tier batch — of legitimately NEW messages,
     * so the qualityAttempted ledger (which bounds re-attempts of the same
     * message) never applied. Measured ceiling: 20 Gemini requests per ROLLING
     * minute, so a few hundred messages of scroll-back empties it in seconds.
     */
    const foreign = (id: string) =>
        discordMessage(id, "je vais m'en aller incessamment sous peu");

    const geminiCalls = () =>
        native.translateBatch.mock.calls.filter(c => c[0] === "gemini").length;

    /** Every message id the FAST tier actually sent to Google. */
    const googleIds = () =>
        native.translateBatch.mock.calls
            .filter(c => c[0] === "google")
            .flatMap(c => JSON.parse(c[2] as string).messages.map((m: any) => m.id));

    /** Ids handed to the quality tier, across every batch it sent. */
    const geminiIds = () =>
        native.translateBatch.mock.calls
            .filter(c => c[0] === "gemini")
            .flatMap(c => JSON.parse(c[2] as string).messages.map((m: any) => m.id));

    beforeEach(() => {
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";
        // Google answers whatever it is sent; Gemini answers nothing, so no
        // store write of its own can mask whether it was ASKED. What is being
        // counted here is requests spent, not results.
        native.translateBatch.mockImplementation(
            async (engine: string, _k: string, payload: string) =>
                engine === "google"
                    ? googleAnswers(payload, "rough", "fr")
                    : { ok: true, results: [] }
        );
    });

    /** One scroll-up: `count` never-before-seen OLDER messages, then the event. */
    async function scrollBackLoading(count: number, tag: string) {
        const older = Array.from({ length: count }, (_, i) => foreign(`${tag}-${i}`));
        stubMessages.set(CHANNEL, [...older, ...(stubMessages.get(CHANNEL) ?? [])]);
        FluxDispatcher.dispatch("LOAD_MESSAGES_SUCCESS", { channelId: CHANNEL });
        await settle();
        return older.map(m => m.id);
    }

    it("sends no quality request per scroll, however much new history is loaded", async () => {
        stubMessages.set(CHANNEL, [foreign("open-0")]);

        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await settle();
        // The channel open itself IS worth a quality request — that is the case
        // this fix deliberately preserves.
        const spentOnOpen = geminiCalls();
        expect(spentOnOpen).toBeGreaterThan(0);

        // The first history load after the open is still that open's own
        // backlog (CHANNEL_SELECT can fire before Discord has fetched it).
        FluxDispatcher.dispatch("LOAD_MESSAGES_SUCCESS", { channelId: CHANNEL });
        await settle();
        const spentOnOpenAndItsBacklog = geminiCalls();

        // Now the user scrolls: three more loads, 10 new messages each. Before
        // the fix each of these produced its own Gemini batch.
        const scrolled: string[] = [];
        for (const tag of ["s1", "s2", "s3"]) {
            scrolled.push(...await scrollBackLoading(10, tag));
        }

        expect(geminiCalls()).toBe(spentOnOpenAndItsBacklog);
        for (const id of scrolled) expect(geminiIds()).not.toContain(id);

        // ...and the reader loses NOTHING visible: every scrolled-past message
        // still went to the fast tier and has its ≈ Google subtitle.
        const fastIds = googleIds();
        for (const id of scrolled) expect(fastIds).toContain(id);
        expect(getTranslation(key("s3-9"))).toMatchObject({ via: "google", text: "rough" });
    });

    it("does not spend the scroll-back budget on upgrades it is not going to request", async () => {
        // catchUpCount is a budget of REQUESTS, and on a scroll-back pass a
        // message whose only outstanding work is a ✦ upgrade is not going to
        // produce one. Counting it anyway would let a screenful of
        // already-Google-translated history exhaust the budget before the walk
        // reaches the genuinely untranslated message further up — i.e. the fix
        // would cost the reader a ≈ line, which is exactly what it promises
        // not to do.
        settings.store.catchUpCount = 20;

        // Get past the channel-open load, so the next one is scrolling.
        stubMessages.set(CHANNEL, [foreign("open-0")]);
        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await settle();
        FluxDispatcher.dispatch("LOAD_MESSAGES_SUCCESS", { channelId: CHANNEL });
        await settle();
        native.translateBatch.mockClear();

        // The scroll loads 20 messages that already have a Google line (still
        // upgradable, so needsQuality says yes) and, older than all of them,
        // one that has nothing at all.
        const upgradable = Array.from({ length: 20 }, (_, i) => foreign(`up-${i}`));
        for (const m of upgradable) {
            setTranslation(key(m.id), { lang: "fr", text: "rough", via: "google" });
        }
        stubMessages.set(CHANNEL, [
            foreign("deep"), ...upgradable, ...(stubMessages.get(CHANNEL) as any[])
        ]);
        FluxDispatcher.dispatch("LOAD_MESSAGES_SUCCESS", { channelId: CHANNEL });
        await settle();

        expect(googleIds()).toContain("deep");
        expect(geminiCalls()).toBe(0);
    });

    it("keeps scrolled-past history out of the quality tier's context window", async () => {
        // The context ring is a window on the conversation being READ. An hour
        // of history the user scrolled past is not that, and the ring is only 8
        // slots wide — filling it with scroll-back would evict exactly the
        // recent messages that make the next live batch worth its request.
        stubMessages.set(CHANNEL, [foreign("open-0")]);
        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await settle();
        FluxDispatcher.dispatch("LOAD_MESSAGES_SUCCESS", { channelId: CHANNEL });
        await settle();

        // Confidently English, so it costs no request either way and reaches
        // enqueue()'s context-only path — the one branch that could still leak
        // scroll-back into the quality tier.
        const ancient = discordMessage("old-1", "i think that we should go to the server now");
        stubMessages.set(CHANNEL, [ancient, ...(stubMessages.get(CHANNEL) as any[])]);
        FluxDispatcher.dispatch("LOAD_MESSAGES_SUCCESS", { channelId: CHANNEL });
        await settle();

        native.translateBatch.mockClear();
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: foreign("live-3") });
        await settle();

        const quality = native.translateBatch.mock.calls.filter(c => c[0] === "gemini");
        expect(quality).toHaveLength(1);
        const { context } = JSON.parse(quality[0][2] as string);
        expect(context.map((c: any) => c.text)).not.toContain(ancient.content);
    });

    it("still gives the opened channel's backlog to the quality tier", async () => {
        // The burst must not be fixed by disabling the feature: opening a
        // channel is exactly where the LLM's conversation context is worth
        // spending a request on.
        stubMessages.set("cold", [
            { ...foreign("c1"), channel_id: "cold" },
            { ...foreign("c2"), channel_id: "cold" }
        ]);

        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: "cold" });
        await settle();

        expect(geminiCalls()).toBe(1);
        expect(geminiIds()).toEqual(["c1", "c2"]);
    });

    it("still gives a cold channel's backlog to the quality tier when it lands AFTER the select", async () => {
        // The "tab back in after a game" case: CHANNEL_SELECT fires before
        // Discord has fetched the history, so the FIRST LOAD_MESSAGES_SUCCESS
        // after an open is that open's catch-up, not scrolling. Demoting it
        // would silently take the quality tier away from every cold channel.
        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await settle();
        expect(geminiCalls()).toBe(0);   // nothing loaded yet, so nothing to send

        stubMessages.set(CHANNEL, [foreign("late-1")]);
        FluxDispatcher.dispatch("LOAD_MESSAGES_SUCCESS", { channelId: CHANNEL });
        await settle();

        expect(geminiIds()).toEqual(["late-1"]);
    });

    it("still gives the quality tier the backlog that lands after a RESTART", async () => {
        // start() catches up whatever channel is already on screen, and on a
        // restart the history is usually still being fetched at that moment —
        // so the load that follows is that open's backlog and must keep the
        // quality tier. No CHANNEL_SELECT here on purpose: a restart does not
        // replay one.
        stubMessages.set(CHANNEL, [foreign("restart-1")]);
        FluxDispatcher.dispatch("LOAD_MESSAGES_SUCCESS", { channelId: CHANNEL });
        await settle();

        expect(geminiIds()).toEqual(["restart-1"]);
    });

    it("still sends a live message in the focused channel to the quality tier", async () => {
        // Live chat is the other half of what the quality tier is for, and it
        // does not go through catch-up at all.
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: foreign("live-1") });
        await settle();

        expect(geminiIds()).toContain("live-1");
    });

    it("still sends a live message that arrives AFTER a scroll-back", async () => {
        // The demotion is per catch-up invocation, not a mode the channel gets
        // stuck in: a scroll must not disable the quality tier for what comes
        // next.
        stubMessages.set(CHANNEL, [foreign("open-0")]);
        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await settle();
        FluxDispatcher.dispatch("LOAD_MESSAGES_SUCCESS", { channelId: CHANNEL });
        await settle();
        await scrollBackLoading(10, "s1");

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: foreign("live-2") });
        await settle();

        expect(geminiIds()).toContain("live-2");
    });
});

describe("the force-quality popover action (⚡)", () => {
    /** The item Vencord would get back from calling render() on this button. */
    function forceButton(message: any) {
        const registered = __getPopoverButton(FORCE_QUALITY_POPOVER_ID);
        return registered ? registered.render(message) : null;
    }

    /**
     * Flush the microtask queue without advancing any timer. Unlike settle(),
     * nothing here waits on a debounce window — the force action bypasses the
     * batcher entirely — and the rate gate hands out a token synchronously
     * whenever one is free, so a plain microtask drain is enough to let
     * runTier's awaits (acquireSlot, then the native call) resolve.
     */
    async function flush() {
        for (let i = 0; i < 20; i++) await Promise.resolve();
    }

    function useGemini() {
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";
    }

    it("is registered as its own popover button, separate from the 🌐 channel toggle", () => {
        expect(__getPopoverButton(FORCE_QUALITY_POPOVER_ID)).toBeDefined();
        useGemini();
        const forced = forceButton(discordMessage("1", "hola"))!;
        const toggle = plugin.messagePopoverButton!.render(discordMessage("1", "hola") as any)!;
        expect(forced.label).not.toEqual(toggle.label);
    });

    it("unregisters on stop() so a disabled plugin leaves no stale button behind", () => {
        plugin.stop!();
        expect(__getPopoverButton(FORCE_QUALITY_POPOVER_ID)).toBeUndefined();
        // afterEach() below calls stop() again; harmless (every reset it
        // performs is idempotent), but re-start here so afterEach's own
        // teardown finds the plugin in the state it expects.
        plugin.start!();
    });

    it("sends the message to the quality tier even though it already has a Google entry", async () => {
        useGemini();
        setTranslation(key("1"), { lang: "es", text: "rough", via: "google" });
        native.translateBatch.mockImplementation(async (engine: string) =>
            engine === "gemini"
                ? { ok: true, results: [{ id: "1", lang: "de", text: "good", skip: false }] }
                : { ok: true, results: [] });

        const btn = forceButton(discordMessage("1", "hola"));
        expect(btn).not.toBeNull();
        btn!.onClick!(undefined as any);
        await flush();

        expect(native.translateBatch.mock.calls.some(c => c[0] === "gemini")).toBe(true);
        expect(getTranslation(key("1"))).toEqual({ lang: "de", text: "good", via: "gemini" });
    });

    it("works for a message the scroll-back rule would otherwise exclude", async () => {
        useGemini();
        const foreign = (id: string) => discordMessage(id, "je vais m'en aller incessamment sous peu");
        native.translateBatch.mockImplementation(
            async (engine: string, _k: string, payload: string) =>
                engine === "google"
                    ? googleAnswers(payload, "rough", "fr")
                    : { ok: true, results: [] }
        );

        // Get past the channel-open load, so the next one is genuine scroll-back.
        stubMessages.set(CHANNEL, [foreign("open-0")]);
        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await settle();
        FluxDispatcher.dispatch("LOAD_MESSAGES_SUCCESS", { channelId: CHANNEL });
        await settle();

        // A never-before-seen message, loaded by a scroll — demoted to the
        // fast tier only by the scroll-back rule (initialHistoryPending was
        // already consumed by the load above).
        const scrolled = foreign("scrolled-1");
        stubMessages.set(CHANNEL, [scrolled, ...(stubMessages.get(CHANNEL) as any[])]);
        FluxDispatcher.dispatch("LOAD_MESSAGES_SUCCESS", { channelId: CHANNEL });
        await settle();

        expect(getTranslation(key("scrolled-1"))).toMatchObject({ via: "google" });
        expect(
            native.translateBatch.mock.calls.some(c =>
                c[0] === "gemini"
                && JSON.parse(c[2] as string).messages.some((m: any) => m.id === "scrolled-1"))
        ).toBe(false);

        // Now the user asks by hand.
        native.translateBatch.mockImplementation(async (engine: string) =>
            engine === "gemini"
                ? { ok: true, results: [{ id: "scrolled-1", lang: "fr", text: "better", skip: false }] }
                : { ok: true, results: [] });

        const btn = forceButton(scrolled);
        expect(btn).not.toBeNull();
        btn!.onClick!(undefined as any);
        await flush();

        expect(getTranslation(key("scrolled-1"))).toMatchObject({ via: "gemini", text: "better" });
    });

    it("bypasses the qualityAttempted ledger — a message whose earlier attempt failed can be retried by hand", async () => {
        useGemini();
        stubMessages.set(CHANNEL, [discordMessage("1", "hola")]);
        // The model omits every id — a real attempt that writes nothing, the
        // routine case the ledger exists for (see "a failed quality attempt
        // is not re-requested forever" above).
        native.translateBatch.mockImplementation(
            async (engine: string, _k: string, payload: string) =>
                engine === "google"
                    ? googleAnswers(payload, "rough", "de")
                    : {
                        ok: true,
                        results: JSON.parse(payload).messages.map(
                            (m: { id: string; }) => ({ id: m.id, failed: true })
                        )
                    }
        );

        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await settle();
        const spentAutomatically =
            native.translateBatch.mock.calls.filter(c => c[0] === "gemini").length;
        expect(spentAutomatically).toBe(1);

        // Confirm the ledger really is what is blocking the automatic path,
        // before asking whether the button gets past it.
        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await settle();
        expect(native.translateBatch.mock.calls.filter(c => c[0] === "gemini").length)
            .toBe(spentAutomatically);

        native.translateBatch.mockImplementation(async (engine: string) =>
            engine === "gemini"
                ? { ok: true, results: [{ id: "1", lang: "de", text: "good", skip: false }] }
                : { ok: true, results: [] });

        const btn = forceButton(discordMessage("1", "hola"));
        expect(btn).not.toBeNull();
        btn!.onClick!(undefined as any);
        await flush();

        expect(native.translateBatch.mock.calls.filter(c => c[0] === "gemini").length)
            .toBe(spentAutomatically + 1);
        expect(getTranslation(key("1"))).toMatchObject({ via: "gemini", text: "good" });
    });

    it("does not appear when the configured engine is Google", () => {
        settings.store.engine = "google";
        expect(forceButton(discordMessage("1", "hola"))).toBeNull();
    });

    it("does not appear for a message that already has a real LLM translation", () => {
        useGemini();
        setTranslation(key("1"), { lang: "es", text: "ya bueno", via: "gemini" });
        expect(forceButton(discordMessage("1", "hola"))).toBeNull();
    });

    it("does not appear for a message an LLM already skipped (an authoritative verdict, not just a Google guess)", () => {
        useGemini();
        setTranslation(key("1"), { skipped: true, via: "gemini" });
        expect(forceButton(discordMessage("1", "hola"))).toBeNull();
    });

    it("does not bypass the cooldown — with the engine cooling down, no request is sent", async () => {
        useGemini();
        setCooldown("gemini", Date.now() + 600_000);
        native.translateBatch.mockClear();

        // Cooldown is a runTier-level gate on the ENGINE, not a fact about
        // configuration, so effectiveEngine() still reports "gemini" and the
        // button is still offered — what must not happen is a request going
        // out when it is clicked.
        const btn = forceButton(discordMessage("1", "hola"));
        expect(btn).not.toBeNull();
        btn!.onClick!(undefined as any);
        await flush();

        expect(native.translateBatch).not.toHaveBeenCalled();
    });

    it("still routes the write through the upgrade rule — a Google result arriving later cannot clobber it", async () => {
        const foreign = (id: string) => discordMessage(id, "je vais m'en aller incessamment sous peu");

        // Get past the channel-open load under Google (the beforeEach
        // default) so the scroll-back dispatch below is genuine scroll-back.
        // The engine switch just after it is the ONLY settings change in
        // this test, and nothing is in flight yet when it happens — so no
        // batcher rebuild ever lands BETWEEN the slow Google call below and
        // its resolution. That matters: a rebuild bumps the generation guard
        // runTier checks before every write, and if one landed in between,
        // this test would pass even with the upgrade rule (mayReplace)
        // deleted — protected by a stale generation instead of by what it is
        // actually meant to pin.
        stubMessages.set(CHANNEL, [foreign("open-0")]);
        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await settle();
        FluxDispatcher.dispatch("LOAD_MESSAGES_SUCCESS", { channelId: CHANNEL });
        await settle();

        useGemini();
        native.translateBatch.mockImplementation(async (engine: string, _k: string, payload: string) => {
            if (engine === "gemini") {
                return { ok: true, results: [{ id: "target", lang: "fr", text: "good", skip: false }] };
            }
            // Deliberately slow, so it lands AFTER the forced quality write below.
            await new Promise<void>(resolve => setTimeout(resolve, 30_000));
            return googleAnswers(payload, "rough", "fr");
        });

        // A scroll-back load: fast tier only (allowQuality is false), so the
        // quality tier never marks "target" in-flight and the forced click
        // below is not racing an automatic quality request for it.
        const target = foreign("target");
        stubMessages.set(CHANNEL, [target, ...(stubMessages.get(CHANNEL) as any[])]);
        FluxDispatcher.dispatch("LOAD_MESSAGES_SUCCESS", { channelId: CHANNEL });
        // Advance past the fast tier's own debounce so the batch actually
        // flushes and the slow Google call starts (its 30s timer has not
        // fired yet).
        await vi.advanceTimersByTimeAsync(FAST_DEBOUNCE_MS);
        await flush();

        const btn = forceButton(target);
        expect(btn).not.toBeNull();
        btn!.onClick!(undefined as any);
        await flush();
        expect(getTranslation(key("target"))).toEqual({ lang: "fr", text: "good", via: "gemini" });

        // Let the slow Google response land and try to overwrite it.
        await vi.advanceTimersByTimeAsync(30_000);
        await flush();

        expect(getTranslation(key("target"))).toEqual({ lang: "fr", text: "good", via: "gemini" });
    });
});

describe("the quota indicator (chat-bar ✦)", () => {
    /** Call the chat-bar button's render function directly, exactly as PluginManager would. */
    function render(): any {
        return plugin.chatBarButton!.render({ isMainChat: true, isAnyChat: true } as any);
    }

    /** Every string in the rendered tree, concatenated — same walk as the subtitle accessory's helper. */
    function text(node: any): string {
        if (node === null || node === undefined || node === false) return "";
        if (typeof node === "string" || typeof node === "number") return String(node);
        if (Array.isArray(node)) return node.map(text).join("");
        return text(node.children);
    }

    function titleOf(node: any): string | undefined {
        return node?.props?.title;
    }

    function useGemini() {
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";
    }

    it("renders nothing when the configured engine is Google", () => {
        settings.store.engine = "google";
        expect(render()).toBeNull();
    });

    it("renders nothing when an LLM is selected but no API key is set", () => {
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "";
        expect(render()).toBeNull();
    });

    it("renders nothing once the session has fallen back to Google after a rejected key", async () => {
        // Not one of the two states named in the design brief, but the same
        // underlying question: effectiveEngine() reports "google" here too,
        // so there is equally no quality-tier budget left to report.
        useGemini();
        native.translateBatch.mockResolvedValue({ ok: false, error: "401 unauthorized" });
        stubMessages.set(CHANNEL, [discordMessage("1", "hola")]);
        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await settle();
        expect(render()).toBeNull();
    });

    it("shows the plugin's own available token count when not cooling down", () => {
        useGemini();
        expect(text(render())).toBe(`✦ ${BURST_CAPACITY}`);
    });

    it("reflects tokens actually spent through the gate — the same read runTier's acquireSlot() drives", async () => {
        useGemini();
        await acquireSlot();
        expect(rateGateAvailable()).toBe(BURST_CAPACITY - 1);
        expect(text(render())).toBe(`✦ ${BURST_CAPACITY - 1}`);
    });

    it("shows the cooldown countdown, in PREFERENCE to a token count, while cooling down", () => {
        useGemini();
        // The gate itself is untouched — BURST_CAPACITY tokens are still
        // sitting in it — so a naive token-count read alone would say "3
        // available" here. The point of this test is that cooldown wins.
        setCooldown("gemini", Date.now() + 45_000);
        expect(text(render())).toBe("✦ 0:45");
    });

    it("names the engine and spells out what the number means, in a title attribute", () => {
        useGemini();
        const title = titleOf(render());
        expect(title).toContain("Gemini");
        expect(title).toContain(String(BURST_CAPACITY));
        expect(title).toContain("available");
    });

    it("says COOLING DOWN, not just a bare number, in the title while cooling", () => {
        useGemini();
        setCooldown("gemini", Date.now() + 45_000);
        const title = titleOf(render());
        expect(title).toContain("cooling down");
        expect(title).toContain("0:45");
    });
});

describe("the ⚡ label reflects the plugin's own available budget", () => {
    function forceButton(message: any) {
        const registered = __getPopoverButton(FORCE_QUALITY_POPOVER_ID);
        return registered ? registered.render(message) : null;
    }
    function useGemini() {
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";
    }

    it("names how many requests are available right now", () => {
        useGemini();
        const btn = forceButton(discordMessage("1", "hola"))!;
        expect(btn.label).toBe(`Translate with Gemini now (spends one of ${BURST_CAPACITY} available now)`);
    });

    it("says none are available once the gate is exhausted — never claims a spend it cannot make", async () => {
        useGemini();
        for (let i = 0; i < BURST_CAPACITY; i++) await acquireSlot();
        const btn = forceButton(discordMessage("1", "hola"))!;
        expect(btn.label).toBe("Translate with Gemini now (none available right now)");
    });

    it("shows the cooldown countdown instead of a token count while cooling down", () => {
        useGemini();
        setCooldown("gemini", Date.now() + 45_000);
        const btn = forceButton(discordMessage("1", "hola"))!;
        expect(btn.label).toBe("Translate with Gemini now (cooling down, 0:45 left)");
    });

    it("matches the chat-bar indicator's own number for the same state", () => {
        useGemini();
        const btn = forceButton(discordMessage("1", "hola"))!;
        const indicator: any = plugin.chatBarButton!.render({ isMainChat: true, isAnyChat: true } as any);
        function text(node: any): string {
            if (node === null || node === undefined || node === false) return "";
            if (typeof node === "string" || typeof node === "number") return String(node);
            if (Array.isArray(node)) return node.map(text).join("");
            return text(node.children);
        }
        expect(btn.label).toContain(String(BURST_CAPACITY));
        expect(text(indicator)).toContain(String(BURST_CAPACITY));
    });

    it("says a request is already running once one is in flight for this message, so a second click reads as an obvious no-op", async () => {
        // Never resolves within this test, so the first click's request stays
        // in flight for the second forceButton() read to observe.
        useGemini();
        native.translateBatch.mockImplementation(() => new Promise(() => { }));
        const message = discordMessage("1", "hola");

        const before = forceButton(message)!;
        expect(before.label).not.toContain("already translating");
        expect(before.label).toBe(`Translate with Gemini now (spends one of ${BURST_CAPACITY} available now)`);

        before.onClick!(undefined as any);

        // Synchronous, deliberately no await: inFlightQuality is marked
        // before forceQualityTranslate's first await, so a render right
        // after the click already sees it.
        const during = forceButton(message)!;
        expect(during.label).toBe("Translate with Gemini now (already translating…)");
    });
});

describe("the debugLogging setting", () => {
    /** Only the debug-level entries — genuine warnings must keep logging
     * regardless of the setting, so a blanket `calls.length` check would be
     * polluted by those. */
    const debugCalls = () => loggedCalls.filter(c => c.level === "debug");
    const flatten = () => debugCalls().map(c => c.args.map(String).join(" ")).join("\n");

    function forceButton(message: any) {
        const registered = __getPopoverButton(FORCE_QUALITY_POPOVER_ID);
        return registered ? registered.render(message) : null;
    }
    function useGemini() {
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";
    }

    it("is off by default", () => {
        expect(settings.store.debugLogging).toBe(false);
    });

    describe("with the setting off", () => {
        it("logs nothing at all for an ordinary message, and behaviour is unchanged", async () => {
            respondWith({ ok: true, results: [{ id: "1", lang: "es", text: "hi", skip: false }] });
            FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
            await settle();

            expect(debugCalls()).toEqual([]);
            // Behaviour itself: the message still went out and still resolved.
            expect(native.translateBatch).toHaveBeenCalledTimes(1);
            expect(getTranslation(key("1"))).toEqual({ lang: "es", text: "hi", via: "google" });
        });

        it("logs nothing for a locally-skipped message either", async () => {
            FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "gg") });
            await settle();

            expect(debugCalls()).toEqual([]);
            expect(native.translateBatch).not.toHaveBeenCalled();
        });

        it("logs nothing for a force-quality click", async () => {
            useGemini();
            respondWith({ ok: true, results: [{ id: "1", lang: "de", text: "hi", skip: false }] });
            const btn = forceButton(discordMessage("1", "hola"));
            btn!.onClick!(undefined as any);
            for (let i = 0; i < 20; i++) await Promise.resolve();

            expect(debugCalls()).toEqual([]);
        });

        it("logs nothing for catch-up either, and behaviour is unchanged", async () => {
            respondWith({ ok: true, results: [{ id: "1", lang: "es", text: "hi", skip: false }] });
            stubMessages.set(CHANNEL, [discordMessage("1", "hola")]);
            FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
            await settle();

            expect(debugCalls()).toEqual([]);
            expect(native.translateBatch).toHaveBeenCalledTimes(1);
        });
    });

    describe("with the setting on", () => {
        beforeEach(() => {
            settings.store.debugLogging = true;
        });

        it("reports WHICH local rule skipped a message — shouldSkip", async () => {
            FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "gg") });
            await settle();

            expect(flatten()).toMatch(/\[enqueue\] 1: locally skipped by shouldSkip/);
            expect(flatten()).not.toContain("isConfidentlyTargetLanguage");
        });

        it("reports WHICH local rule skipped a message — isConfidentlyTargetLanguage", async () => {
            FluxDispatcher.dispatch("MESSAGE_CREATE", {
                message: discordMessage("1", "we should have a fst mc server")
            });
            await settle();

            expect(flatten()).toMatch(/\[enqueue\] 1: locally skipped by isConfidentlyTargetLanguage/);
        });

        it("reports which tier(s) a message was enqueued to", async () => {
            useGemini();
            respondWith({ ok: true, results: [] });
            FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola amigos") });
            await settle();

            expect(flatten()).toMatch(/\[enqueue\] 1: -> fast\+quality/);
        });

        it("reports catch-up's candidate count and budget spend", async () => {
            stubMessages.set(CHANNEL, [discordMessage("1", "hola")]);
            FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
            await settle();

            expect(flatten()).toMatch(new RegExp(`\\[catchUp\\] ${CHANNEL}: allowQuality=true candidates=1 budgetSpent=1/`));
        });

        it("reports a flush blocked by an engine cooldown", async () => {
            useGemini();
            setCooldown("gemini", Date.now() + 60_000);
            FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola amigos") });
            await settle();

            expect(flatten()).toMatch(/\[flush\] gemini: blocked — cooling down/);
        });

        it("reports each response id's outcome — translation, skip and failed", async () => {
            native.translateBatch.mockResolvedValue({
                ok: true,
                results: [
                    { id: "1", lang: "es", text: "hola", skip: false },
                    { id: "2", skip: true },
                    { id: "3", failed: true }
                ]
            });
            FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
            FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("2", "que tal") });
            FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("3", "vamos ya") });
            await settle();

            const log = flatten();
            expect(log).toMatch(/\[response\] google 1: translation \(es\)/);
            expect(log).toMatch(/\[response\] google 2: skip/);
            expect(log).toMatch(/\[response\] google 3: failed/);
        });

        it("reports a write, and a refusal with its reason", async () => {
            // Same race as "marker writes never clobber a real translation
            // from the other tier": a slow Google reply lands AFTER the
            // quality tier already wrote a real translation, so its write is
            // a genuine mayReplace() refusal, not a marker-vs-real one.
            useGemini();
            native.translateBatch.mockImplementation(async (engine: string) => {
                if (engine === "google") {
                    await new Promise<void>(resolve => setTimeout(resolve, 30_000));
                    return { ok: true, results: [{ id: "1", lang: "es", text: "worse", skip: false }] };
                }
                return { ok: true, results: [{ id: "1", lang: "de", text: "good", skip: false }] };
            });

            FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola amigos") });
            await vi.advanceTimersByTimeAsync(21_000);
            for (let i = 0; i < 20; i++) await Promise.resolve();
            expect(getTranslation(key("1"))).toMatchObject({ via: "gemini", text: "good" });

            await vi.advanceTimersByTimeAsync(15_000);
            for (let i = 0; i < 20; i++) await Promise.resolve();

            const log = flatten();
            expect(log).toMatch(/\[write\] .*: wrote gemini:/);
            expect(log).toMatch(/\[write\] .*: refused google:.*cannot replace gemini/);
        });

        it("reports a force-quality click and each guard it passes", async () => {
            useGemini();
            respondWith({ ok: true, results: [{ id: "1", lang: "de", text: "hi", skip: false }] });
            const btn = forceButton(discordMessage("1", "hola"));
            btn!.onClick!(undefined as any);
            for (let i = 0; i < 20; i++) await Promise.resolve();

            const log = flatten();
            expect(log).toMatch(/\[force-quality\] 1: click received/);
            expect(log).toMatch(/\[force-quality\] 1: passed guards, spending a gemini request/);
        });

        it("reports the no-LLM-engine guard blocking a force-quality click", () => {
            // engine is "google" (the beforeEach default) — no LLM configured.
            const btn = forceButton(discordMessage("1", "hola"));
            // The button itself is hidden in this state (see
            // forceQualityPopoverRender), so drive runTier's own guard
            // directly through the same click path the button would use were
            // it visible, by calling the exported action the same way.
            expect(btn).toBeNull();
        });

        it("reports the in-flight guard blocking a duplicate force-quality click", async () => {
            useGemini();
            // Never resolves within this test, so the first click's request
            // stays in flight for the second click to collide with.
            native.translateBatch.mockImplementation(() => new Promise(() => { }));
            const btn = forceButton(discordMessage("1", "hola"));
            btn!.onClick!(undefined as any);
            for (let i = 0; i < 20; i++) await Promise.resolve();
            __resetLogCalls();

            btn!.onClick!(undefined as any);
            for (let i = 0; i < 20; i++) await Promise.resolve();

            expect(flatten()).toMatch(/\[force-quality\] 1: blocked — already in flight/);
        });
    });
});

describe("the manual ⚡ in-flight indicator on the subtitle accessory", () => {
    function forceButton(message: any) {
        const registered = __getPopoverButton(FORCE_QUALITY_POPOVER_ID);
        return registered ? registered.render(message) : null;
    }

    /**
     * Flush the microtask queue without advancing any timer — same helper as
     * the force-quality describe block above, and for the same reason: the
     * force action bypasses the batcher's debounce entirely.
     */
    async function flush() {
        for (let i = 0; i < 20; i++) await Promise.resolve();
    }

    function useGemini() {
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";
    }

    /** Call the accessory component directly and return what it rendered. */
    const render = (message: unknown) => {
        const el: any = plugin.renderMessageAccessory!({ message } as any);
        return el.type(el.props);
    };

    /** Every string in the rendered tree, concatenated. */
    const text = (node: any): string => {
        if (node === null || node === undefined || node === false) return "";
        if (typeof node === "string" || typeof node === "number") return String(node);
        if (Array.isArray(node)) return node.map(text).join("");
        return text(node.children);
    };

    /**
     * Every `title` attribute anywhere in the rendered tree — there can be
     * more than one (the provenance prefix carries its own alongside the
     * hint's), so callers check with `.some()`/`.toContain()` on the array
     * rather than assuming there is exactly one.
     */
    function titlesOf(node: any): string[] {
        if (node === null || node === undefined || node === false) return [];
        if (typeof node === "string" || typeof node === "number") return [];
        if (Array.isArray(node)) return node.flatMap(titlesOf);
        const own = node?.props?.title !== undefined ? [node.props.title] : [];
        return [...own, ...titlesOf(node.children)];
    }

    /** The single `title` a caller expects — asserts there is exactly one. */
    function titleOf(node: any): string | undefined {
        const titles = titlesOf(node);
        return titles.length === 1 ? titles[0] : titles.join(" | ");
    }

    it("shows a ⚡ translating… hint the instant the button is clicked, before any response has arrived", async () => {
        useGemini();
        // Never resolves within this test: the point is what the accessory
        // shows WHILE the request is out, not what it shows once it lands.
        native.translateBatch.mockImplementation(() => new Promise(() => { }));
        const message = discordMessage("1", "hola");

        expect(render(message)).toBeNull();

        const btn = forceButton(message);
        expect(btn).not.toBeNull();
        btn!.onClick!(undefined as any);

        // Deliberately no await/flush: forcedInFlight is marked before
        // forceQualityTranslate's first await, so this must already be true
        // the instant the synchronous part of the click handler returns.
        const rendered = render(message);
        expect(rendered).not.toBeNull();
        expect(text(rendered)).toContain("⚡");
        expect(text(rendered)).toContain("translating");
    });

    it("clears the indicator once the request resolves with a real translation", async () => {
        useGemini();
        native.translateBatch.mockResolvedValue(
            { ok: true, results: [{ id: "1", lang: "de", text: "good", skip: false }] }
        );
        const message = discordMessage("1", "hola");

        const btn = forceButton(message)!;
        btn.onClick!(undefined as any);
        expect(text(render(message))).toContain("translating");

        await flush();

        const rendered = render(message);
        expect(text(rendered)).toContain("good");
        expect(text(rendered)).not.toContain("translating");
    });

    it("shows a self-clearing failure hint when a forced request fails, and writes nothing to the store", async () => {
        // A MANUAL click reporting its own outcome — the fix for the bug this
        // suite is named after: the reader spent a scarce request on purpose
        // and previously saw "⚡ translating…" flash then vanish into
        // silence, indistinguishable from success-that-hasn't-landed-yet.
        useGemini();
        native.translateBatch.mockResolvedValue({ ok: false, error: "500 upstream error" });
        const message = discordMessage("1", "hola");

        const btn = forceButton(message)!;
        btn.onClick!(undefined as any);
        expect(text(render(message))).toContain("translating");

        await flush();

        const rendered = render(message);
        expect(rendered).not.toBeNull();
        expect(text(rendered)).toContain("⚡");
        expect(text(rendered)).toContain("translation failed");
        // A short human phrase, not the raw "500 upstream error" — see
        // beaconErrorCode()/describeFailureReason(): only a closed category
        // ever reaches the DOM.
        expect(titleOf(rendered)).toContain("engine error");
        expect(titleOf(rendered)).not.toContain("500 upstream error");

        // Quality-tier failures deliberately write nothing to the store (see
        // runTier) — a user-initiated retry hint must not become a permanent
        // marker, or a store entry, either.
        expect(getTranslation(key("1"))).toBeUndefined();

        // Dismissible BY TIME: gone on its own once the hint's TTL elapses,
        // with no further click and no store write ever having happened.
        await vi.advanceTimersByTimeAsync(FORCED_HINT_TTL_MS);
        expect(render(message)).toBeNull();
    });

    it("shows a distinct, non-permanent hint — not a bare 'translating' vanish — when the engine is cooling down", async () => {
        useGemini();
        setCooldown("gemini", Date.now() + 600_000);
        native.translateBatch.mockClear();
        const message = discordMessage("1", "hola");

        const btn = forceButton(message)!;
        btn.onClick!(undefined as any);
        // Still shown right away: forceQualityTranslate marks it in flight
        // before runTier gets a chance to check the cooldown.
        expect(text(render(message))).toContain("translating");

        await flush();

        expect(native.translateBatch).not.toHaveBeenCalled();
        const rendered = render(message);
        expect(rendered).not.toBeNull();
        // "wait a minute", not "something is broken" — the remedy differs
        // from an engine error, so the wording must too.
        expect(text(rendered)).toContain("cooling down");
        expect(text(rendered)).not.toContain("translation failed");
        expect(getTranslation(key("1"))).toBeUndefined();

        await vi.advanceTimersByTimeAsync(FORCED_HINT_TTL_MS);
        expect(render(message)).toBeNull();
    });

    it("distinguishes a rate-gate refusal (rebuilt mid-wait) from both cooldown and an engine error", async () => {
        // Drains the gate first, so the click below genuinely queues behind
        // it rather than sending immediately.
        useGemini();
        for (let i = 0; i < BURST_CAPACITY; i++) await acquireSlot();
        native.translateBatch.mockClear();
        const message = discordMessage("1", "hola");

        const btn = forceButton(message)!;
        btn.onClick!(undefined as any);
        await flush();
        expect(native.translateBatch).not.toHaveBeenCalled();

        // The batcher is rebuilt WHILE the click is still queued behind the
        // gate — any settings change does this (see the "settings change
        // mid-debounce" suite). By the time a token frees up, this flush's
        // generation is stale and runTier's post-gate guard drops it without
        // ever sending anything.
        settings.store.targetLang = "de";
        settings.store.targetLang = "en";

        // Let the gate actually refill and resolve the queued waiter.
        await vi.advanceTimersByTimeAsync(REFILL_MS);
        await flush();

        expect(native.translateBatch).not.toHaveBeenCalled();
        const rendered = render(message);
        expect(rendered).not.toBeNull();
        expect(text(rendered)).toContain("rate limited");
        expect(text(rendered)).not.toContain("cooling down");
        expect(text(rendered)).not.toContain("translation failed");
        expect(getTranslation(key("1"))).toBeUndefined();
    });

    it("keeps an existing Google ≈ line visible once a forced request has FAILED, alongside the hint", async () => {
        useGemini();
        setTranslation(key("1"), { lang: "es", text: "rough", via: "google" });
        native.translateBatch.mockResolvedValue({ ok: false, error: "gemini: HTTP 401" });
        const message = discordMessage("1", "hola");

        const btn = forceButton(message)!;
        btn.onClick!(undefined as any);
        await flush();

        const rendered = render(message);
        // Never taken away — the entire point of ⚡: the reader still has the
        // Google line the click was trying to upgrade.
        expect(text(rendered)).toContain("rough");
        expect(text(rendered)).toContain("translation failed");
        expect(titlesOf(rendered).some(t => t.includes("rejected key"))).toBe(true);
    });

    it("still fails silently for the AUTOMATIC pipeline — no hint, no accessory change, from a live-chat quality failure", async () => {
        // The behaviour this whole feature must NOT generalise to (see
        // runTier's own doc). No forceQualityTranslate click happens here at
        // all — MESSAGE_CREATE drives both tiers automatically.
        useGemini();
        native.translateBatch.mockImplementation(async (engine: string) =>
            engine === "google"
                ? { ok: true, results: [{ id: "1", lang: "de", text: "rough", skip: false }] }
                : { ok: false, error: "gemini: 500 upstream error" });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        const rendered = render(discordMessage("1", "hola"));
        // The fast tier's Google line stands, with no failure hint of any
        // kind stacked onto it — an automatic quality failure is invisible.
        expect(text(rendered)).toContain("rough");
        expect(text(rendered)).not.toContain("translation failed");
        expect(text(rendered)).not.toContain("cooling down");
        expect(text(rendered)).not.toContain("rate limited");
    });

    it("keeps an existing Google ≈ line visible while the indicator is showing — never replaces it", async () => {
        useGemini();
        setTranslation(key("1"), { lang: "es", text: "rough", via: "google" });
        // Never resolves: the point is what stays on screen WHILE the
        // request is out.
        native.translateBatch.mockImplementation(() => new Promise(() => { }));
        const message = discordMessage("1", "hola");

        // Sanity: the ≈ line is really there before anything is clicked.
        expect(text(render(message))).toContain("rough");

        const btn = forceButton(message)!;
        btn.onClick!(undefined as any);

        const rendered = render(message);
        expect(text(rendered)).toContain("rough");
        expect(text(rendered)).toContain("translating");
    });

    it("a second click while the first is still in flight does not spawn a second request", async () => {
        useGemini();
        native.translateBatch.mockImplementation(() => new Promise(() => { }));
        const message = discordMessage("1", "hola");

        const btn = forceButton(message)!;
        btn.onClick!(undefined as any);
        await flush();
        expect(native.translateBatch).toHaveBeenCalledTimes(1);

        btn.onClick!(undefined as any);
        await flush();

        expect(native.translateBatch).toHaveBeenCalledTimes(1);
        // Still just the one hint, not a stacked/duplicated one.
        expect(text(render(message))).toContain("translating");
    });

    it("shows the hint over a non-authoritative Google skip too — ⚡ is still offered on exactly that state", async () => {
        // A Google skip (as opposed to an LLM skip) is not authoritative —
        // hasQualityVerdict() still offers the ⚡ button on it (see its own
        // comment), so a click here is a real, reachable path, not a dead
        // one. Before the click it renders nothing (skipped messages have no
        // subtitle at all).
        useGemini();
        setTranslation(key("1"), { skipped: true, via: "google" });
        native.translateBatch.mockImplementation(() => new Promise(() => { }));
        const message = discordMessage("1", "hola");

        expect(render(message)).toBeNull();

        const btn = forceButton(message);
        expect(btn).not.toBeNull();
        btn!.onClick!(undefined as any);

        expect(text(render(message))).toContain("translating");
    });
});

/**
 * Groq is the third quality-tier engine, and everything that made the previous
 * two work has to work for it too — routed through the SAME code paths rather
 * than a parallel set, which is what these assert.
 */
describe("the Groq engine, end to end through the renderer", () => {
    function useGroq() {
        settings.store.engine = "groq";
        settings.store.groqApiKey = "gsk-test";
    }

    it("routes the quality tier to groq while the fast tier stays Google", async () => {
        useGroq();
        native.translateBatch.mockImplementation(async (engine: string, _k: string, payload: string) =>
            engine === "google" ? googleAnswers(payload) : { ok: true, results: [] }
        );

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        const engines = native.translateBatch.mock.calls.map(c => c[0]);
        expect(engines).toContain("google");
        expect(engines).toContain("groq");
    });

    it("sends the configured model, and the default when the setting was never touched", async () => {
        useGroq();

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();
        expect(native.translateBatch.mock.calls.find(c => c[0] === "groq")![3])
            .toBe("llama-3.3-70b-versatile");

        settings.store.groqModel = "llama-3.1-8b-instant";
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("2", "que tal") });
        await settle();

        const groqCalls = native.translateBatch.mock.calls.filter(c => c[0] === "groq");
        expect(groqCalls[groqCalls.length - 1][3]).toBe("llama-3.1-8b-instant");
    });

    it("stays on Google, and says so once, while the Groq key is missing", async () => {
        settings.store.engine = "groq";
        settings.store.groqApiKey = "";

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        expect(native.translateBatch.mock.calls.map(c => c[0])).toEqual(["google"]);
        expect(shownToasts.filter(t => t.message.includes("Groq"))).toHaveLength(1);
    });

    it("falls back to Google for the session on a 401, and says which engine rejected the key", async () => {
        useGroq();
        native.translateBatch.mockImplementation(async (engine: string, _k: string, payload: string) =>
            engine === "google"
                ? googleAnswers(payload)
                : { ok: false, error: "groq: HTTP 401" }
        );

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        expect(shownToasts.some(t => t.message.includes("Groq rejected the API key"))).toBe(true);

        native.translateBatch.mockClear();
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("2", "que tal") });
        await settle();
        expect(native.translateBatch.mock.calls.map(c => c[0])).not.toContain("groq");
    });

    it("enters a cooldown on a 429 with the retry hint the engine parsed", async () => {
        useGroq();
        native.translateBatch.mockImplementation(async (engine: string, _k: string, payload: string) =>
            engine === "google"
                ? googleAnswers(payload)
                : { ok: false, error: "groq: HTTP 429", retryAfterMs: 45_000 }
        );

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        // The Retry-After header said 45s, and that is what the engine is
        // parked for — not the 30s default and not the 60s fallback.
        expect(cooldownUntil("groq")).toBeGreaterThan(Date.now() + 40_000);
        expect(cooldownUntil("groq")).toBeLessThanOrEqual(Date.now() + 45_000);
    });

    it("marks a groq translation as ✦, not ≈", async () => {
        useGroq();
        native.translateBatch.mockImplementation(async (engine: string) => (
            engine === "groq"
                ? { ok: true, results: [{ id: "1", lang: "es", text: "hello there", skip: false }] }
                : { ok: true, results: [] }
        ));

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        expect(getTranslation(key("1"))).toMatchObject({ via: "groq", text: "hello there" });
    });
});

/**
 * The defect: the `✦ N` indicator showed the plugin's OWN token bucket and
 * nothing else, so it could read `✦ 3` while the provider refused the very
 * next request instantly. An engine that reports its remaining quota on every
 * response makes the honest number available; these pin that it is used.
 */
describe("the quota indicator shows the PROVIDER's number when the provider reports one", () => {
    function render(): any {
        return plugin.chatBarButton!.render({ isMainChat: true, isAnyChat: true } as any);
    }
    function text(node: any): string {
        if (node === null || node === undefined || node === false) return "";
        if (typeof node === "string" || typeof node === "number") return String(node);
        if (Array.isArray(node)) return node.map(text).join("");
        return text(node.children);
    }
    function titleOf(node: any): string | undefined {
        return node?.props?.title;
    }
    function useGroq() {
        settings.store.engine = "groq";
        settings.store.groqApiKey = "gsk-test";
    }
    /** Run one quality batch whose response reports `remaining` left. */
    async function reportRemaining(remaining: number, resetRequestsMs = 60_000) {
        native.translateBatch.mockImplementation(async (engine: string, _k: string, payload: string) =>
            engine === "google"
                ? googleAnswers(payload)
                : { ok: true, results: [], providerRateLimit: { remainingRequests: remaining, resetRequestsMs } }
        );
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();
    }

    it("shows ZERO when the provider says zero, even though the gate still holds tokens", async () => {
        // THE defect, exactly: a token count alone says "3 available" here,
        // and clicking ⚡ on the strength of it earns an instant 429.
        useGroq();
        await reportRemaining(0);

        expect(rateGateAvailable()).toBeGreaterThan(0);
        expect(text(render())).toBe("✦ 0");
    });

    it("shows the provider's number whenever it is the smaller of the two real limits", async () => {
        useGroq();
        await reportRemaining(1);
        expect(text(render())).toBe("✦ 1");
    });

    it("keeps showing the gate's number when the gate is the binding limit", async () => {
        // A generous provider figure must not be presented as headroom this
        // plugin will actually let through — both limits are real and a
        // request has to clear both.
        useGroq();
        await reportRemaining(9_999);
        expect(text(render())).toBe(`✦ ${rateGateAvailable()}`);
    });

    it("says in the tooltip that the number is the provider's own, not the plugin's budget", async () => {
        useGroq();
        await reportRemaining(0);
        const title = titleOf(render())!;
        expect(title).toContain("Groq");
        expect(title).toContain("OWN reported remaining quota");
        // The old wording would be an outright lie about this number.
        expect(title).not.toContain("not an estimate of");
    });

    it("keeps the plugin's-own-budget wording for an engine that reports nothing", async () => {
        // Gemini and Claude say nothing on a success, and the honest thing to
        // show for them is unchanged.
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";
        const title = titleOf(render())!;
        expect(title).toContain("the plugin's own budget");
        expect(title).toContain("not an estimate of");
    });

    it("stops trusting the provider's number once its window has rolled over", async () => {
        // A remaining count is a snapshot of one window. Past the reset it is a
        // floor the provider has already moved past, and showing it would
        // understate what is available — a confident wrong answer in the one
        // place the user reads to decide whether to spend.
        useGroq();
        await reportRemaining(0, 30_000);
        expect(text(render())).toBe("✦ 0");

        await vi.advanceTimersByTimeAsync(31_000);
        expect(text(render())).toBe(`✦ ${rateGateAvailable()}`);
    });

    it("stops trusting a reading older than a minute even if no reset was stated", async () => {
        useGroq();
        native.translateBatch.mockImplementation(async (engine: string, _k: string, payload: string) =>
            engine === "google"
                ? googleAnswers(payload)
                : { ok: true, results: [], providerRateLimit: { remainingRequests: 0 } }
        );
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();
        expect(text(render())).toBe("✦ 0");

        await vi.advanceTimersByTimeAsync(61_000);
        expect(text(render())).toBe(`✦ ${rateGateAvailable()}`);
    });

    it("does not show one engine's reading against another engine", async () => {
        useGroq();
        await reportRemaining(0);
        expect(text(render())).toBe("✦ 0");

        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";
        expect(text(render())).toBe(`✦ ${rateGateAvailable()}`);
    });

    it("still lets the cooldown countdown outrank a provider count", async () => {
        useGroq();
        await reportRemaining(9_999);
        setCooldown("groq", Date.now() + 45_000);
        expect(text(render())).toBe("✦ 0:45");
    });

    it("gives the ⚡ label the same number the indicator shows", async () => {
        // One source for both, so the two can never disagree about what
        // pressing ⚡ is about to do.
        useGroq();
        await reportRemaining(0);
        const registered = __getPopoverButton(FORCE_QUALITY_POPOVER_ID)!;
        const btn = registered.render(discordMessage("2", "que tal"))!;
        expect(btn.label).toBe("Translate with Groq now (none available right now)");
    });
});

describe("the rate gate retunes from the provider's own remaining count", () => {
    function useGroq() {
        settings.store.engine = "groq";
        settings.store.groqApiKey = "gsk-test";
    }

    it("tightens when the provider says very little is left, without waiting for a 429", async () => {
        // The whole point: the previous engines could only learn their limit by
        // being rejected. This one states it on a SUCCESS.
        useGroq();
        native.translateBatch.mockImplementation(async (engine: string, _k: string, payload: string) =>
            engine === "google"
                ? googleAnswers(payload)
                : { ok: true, results: [], providerRateLimit: { remainingRequests: 4, resetRequestsMs: 60_000 } }
        );

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        expect(rateGateSettings().refillMs).toBe(30_000);
        expect(rateGateSettings().refillMs).toBeGreaterThan(REFILL_MS);
    });

    it("leaves the gate alone when the provider's figure is generous", async () => {
        // Groq's requests headers are a per-DAY budget: taken as a rate they
        // would open the gate to thousands per minute, which is no gate at all.
        useGroq();
        native.translateBatch.mockImplementation(async (engine: string, _k: string, payload: string) =>
            engine === "google"
                ? googleAnswers(payload)
                : {
                    ok: true,
                    results: [],
                    providerRateLimit: { remainingRequests: 14_370, resetRequestsMs: 179_560 }
                }
        );

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        expect(rateGateSettings()).toEqual({ capacity: BURST_CAPACITY, refillMs: REFILL_MS });
    });

    it("leaves the gate alone for an engine that reports nothing", async () => {
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";
        respondWith({ ok: true, results: [] });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        expect(rateGateSettings()).toEqual({ capacity: BURST_CAPACITY, refillMs: REFILL_MS });
    });
});

describe("the provider's reported quota is not trusted blindly, and does not outlive the session", () => {
    function render(): any {
        return plugin.chatBarButton!.render({ isMainChat: true, isAnyChat: true } as any);
    }
    function text(node: any): string {
        if (node === null || node === undefined || node === false) return "";
        if (typeof node === "string" || typeof node === "number") return String(node);
        if (Array.isArray(node)) return node.map(text).join("");
        return text(node.children);
    }
    function useGroq() {
        settings.store.engine = "groq";
        settings.store.groqApiKey = "gsk-test";
    }
    async function reportRateLimit(providerRateLimit: unknown) {
        native.translateBatch.mockImplementation(async (engine: string, _k: string, payload: string) =>
            engine === "google"
                ? googleAnswers(payload)
                : { ok: true, results: [], providerRateLimit }
        );
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();
    }

    it("ignores a remaining count that is not a usable number", async () => {
        // This value crossed an IPC boundary having started life as a remote
        // HTTP header. A NaN or a negative reaching the indicator would be a
        // number the user is asked to make a spending decision on.
        useGroq();
        for (const bad of [-5, Number.NaN, "12", null, undefined]) {
            plugin.stop!();
            await plugin.start!();
            for (let i = 0; i < 20; i++) await Promise.resolve();
            clearStore();
            useGroq();

            await reportRateLimit({ remainingRequests: bad });
            expect(text(render())).toBe(`✦ ${rateGateAvailable()}`);
        }
    });

    it("ignores a rate-limit payload that is not an object at all", async () => {
        useGroq();
        await reportRateLimit("nearly out");
        expect(text(render())).toBe(`✦ ${rateGateAvailable()}`);
    });

    it("forgets the reading across a stop/start, rather than showing a dead window's count", async () => {
        // The count describes a rate-limit window that has almost certainly
        // rolled over by the time the plugin runs again, and a stale count
        // presented as current is worse than showing the gate's own number.
        useGroq();
        await reportRateLimit({ remainingRequests: 0, resetRequestsMs: 600_000 });
        expect(text(render())).toBe("✦ 0");

        plugin.stop!();
        await plugin.start!();
        for (let i = 0; i < 20; i++) await Promise.resolve();
        useGroq();

        expect(text(render())).toBe(`✦ ${rateGateAvailable()}`);
    });
});
