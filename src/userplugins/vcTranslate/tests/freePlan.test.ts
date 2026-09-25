import { __resetSettings } from "@api/Settings";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    __resetFreePlan, announceableTrialEnd, DAY_MS, isNewEnding, freeMode, freePlanLine, noteServerTrialEnd, trialEndsAt,
    previewDiffers, previewText, PRICING_URL, TRIAL_MS, trialConfirmed, trialDaysLeft, trialEndedMessage
} from "../freePlan";
import settings from "../settings";
import {
    __resetWeeklyStats, __weeklyStats, closeWeekIfDue, countShown, loadWeeklyStats, WEEK_MS, WEEKLY_KEY,
    weeklyNoteText
} from "../weeklyNote";
import * as DataStore from "./stubs/api-datastore";

const T0 = Date.UTC(2026, 8, 25, 12, 0, 0);

afterEach(() => __resetFreePlan());

describe("the free plan's clock", () => {
    it("is a trial for 7 days from the local start, then click-to-translate", () => {
        expect(TRIAL_MS).toBe(7 * DAY_MS);
        expect(freeMode(T0, T0)).toBe("trial");
        expect(freeMode(T0, T0 + TRIAL_MS - 1)).toBe("trial");
        expect(freeMode(T0, T0 + TRIAL_MS)).toBe("click");
    });

    it("takes the EARLIER of the local end and the relay's end", () => {
        // A wiped settings file restarts the local clock; the relay remembers.
        noteServerTrialEnd(T0 - 1, undefined, T0);
        expect(freeMode(T0, T0)).toBe("click");
        // A relay that says "still running" can never extend a local trial
        // that is over (N2/N3: an unwritten or lapsed relay record).
        noteServerTrialEnd(T0 + 3 * DAY_MS, undefined, T0);
        expect(freeMode(T0 - 30 * DAY_MS, T0)).toBe("click");
        // With no local start at all, the relay's end alone decides.
        expect(freeMode(0, T0)).toBe("trial");
        expect(freeMode(0, T0 + 3 * DAY_MS)).toBe("click");
    });

    it("N2: a provisional relay answer never extends a local trial, and never counts as an ending", () => {
        const start = T0 - TRIAL_MS + DAY_MS;   // one local day left
        noteServerTrialEnd(T0 + TRIAL_MS, T0, T0, true);   // "now + 7 days", provisional
        expect(trialEndsAt(start)).toBe(start + TRIAL_MS);
        expect(freeMode(start, start + TRIAL_MS)).toBe("click");
        expect(announceableTrialEnd(start, start + TRIAL_MS)).toBeNull();
        expect(announceableTrialEnd(start, start + TRIAL_MS + DAY_MS)).toBe(start + TRIAL_MS);
    });

    it("ignores a malformed trialEndsAt rather than acting on it", () => {
        for (const bad of [undefined, null, "soon", NaN, -5, 0, Infinity]) noteServerTrialEnd(bad);
        expect(trialConfirmed(T0, T0)).toBe(false);
        expect(freeMode(T0, T0)).toBe("trial");
    });

    it("confirms a trial only when the relay said so and it has not run out", () => {
        expect(trialConfirmed(T0, T0)).toBe(false);
        noteServerTrialEnd(T0 + DAY_MS, undefined, T0);
        expect(trialConfirmed(T0, T0)).toBe(true);
        expect(trialConfirmed(T0, T0 + DAY_MS)).toBe(false);
        // …and not past the LOCAL end either, whatever the relay says.
        noteServerTrialEnd(T0 + 30 * DAY_MS, undefined, T0);
        expect(trialConfirmed(T0, T0 + TRIAL_MS)).toBe(false);
    });

    it("counts days left rounded up, never 0 while the trial runs", () => {
        expect(trialDaysLeft(T0, T0)).toBe(7);
        expect(trialDaysLeft(T0, T0 + 1)).toBe(7);
        expect(trialDaysLeft(T0, T0 + 6 * DAY_MS)).toBe(1);
        expect(trialDaysLeft(T0, T0 + TRIAL_MS - 1)).toBe(1);
        expect(trialDaysLeft(T0, T0 + TRIAL_MS)).toBe(0);
    });
});

describe("the settings line under the Subline code", () => {
    it("says how many trial days are left", () => {
        expect(freePlanLine(true, T0, T0)).toBe("Free trial: 7 days left.");
        expect(freePlanLine(true, T0, T0 + 6 * DAY_MS + 1)).toBe("Free trial: 1 day left.");
    });

    it("says what the free plan does once the trial is over", () => {
        expect(freePlanLine(true, T0, T0 + TRIAL_MS)).toBe("Free plan: messages translate when you click.");
    });

    it("says nothing at all to a paid install", () => {
        expect(freePlanLine(false, T0, T0)).toBeNull();
        expect(freePlanLine(false, T0, T0 + TRIAL_MS)).toBeNull();
    });

    it("is a read-only component in settings, hidden for a paid install", () => {
        __resetSettings();
        const def: any = (settings as any).def.freePlanStatus;
        expect(def).toBeDefined();
        expect(def.hidden()).toBe(false);
        settings.store.freeTrialStartedAt = Date.now();
        const el: any = def.component();
        expect(el.children.join("")).toBe("Free trial: 7 days left.");

        settings.store.freeTrialStartedAt = Date.now() - TRIAL_MS - 1;
        const after: any = def.component();
        // "Free plan: messages translate when you click. Upgrade", with Upgrade a link.
        expect(after.children[0]).toBe("Free plan: messages translate when you click.");
        const link = after.children[2];
        expect(link.type).toBe("a");
        expect(link.props.href).toBe(PRICING_URL);
        expect(link.children).toEqual(["Upgrade"]);

        settings.store.sublineCode = "SUBLINE-PAID";
        expect(def.hidden()).toBe(true);
        expect(def.component()).toBeNull();
        __resetSettings();
    });

    it("sits directly under the Subline code field", () => {
        const keys = Object.keys((settings as any).def);
        expect(keys.indexOf("freePlanStatus")).toBe(keys.indexOf("sublineCode") + 1);
    });

    it("keeps the trial bookkeeping out of the settings UI", () => {
        const def: any = (settings as any).def;
        // CUSTOM settings are never rendered by Vencord.
        expect(def.freeTrialStartedAt.type).toBe(7);
        expect(def.freeTrialEndNoticeFor.type).toBe(7);
    });
});

describe("the copy", () => {
    it("uses the agreed sentences, with no em dash", () => {
        expect(trialEndedMessage()).toBe(
            "Your 7-day free trial ended. Messages now translate when you click. Upgrade to keep it automatic."
        );
        expect(PRICING_URL).toBe("https://surfer05.github.io/subline/#pricing");
        for (const s of [
            trialEndedMessage(), freePlanLine(true, T0, T0)!, freePlanLine(true, T0, T0 + TRIAL_MS)!,
            weeklyNoteText(12, 3)
        ]) expect(s).not.toContain("—");
    });
});

describe("the ✦ preview cut (mirrors the relay)", () => {
    it("keeps the first 5 words and says so", () => {
        expect(previewText("the leak says the album drops friday")).toEqual({
            text: "the leak says the album", truncated: true
        });
    });

    it("leaves a short line whole, and does not flag it", () => {
        expect(previewText("  see you   tomorrow ")).toEqual({ text: "see you tomorrow", truncated: false });
    });

    it("caps a long unspaced line at 32 characters", () => {
        const cjk = "今日はとても良い天気ですね本当に素晴らしい一日になりそうですね皆さん";
        const out = previewText(cjk);
        expect(Array.from(out.text)).toHaveLength(32);
        expect(out.truncated).toBe(true);
    });

    it("hides a preview that reads the same as ≈ over the words it shows", () => {
        expect(previewDiffers("I don't want to go", "I don't want to go home")).toBe(false);
        expect(previewDiffers("Hello, there.", "hello there")).toBe(false);
        expect(previewDiffers("I want to go", "I don't want to go home")).toBe(true);
    });
});

describe("the weekly note", () => {
    beforeEach(async () => {
        DataStore.__reset();
        __resetWeeklyStats();
        await loadWeeklyStats(T0);
    });

    it("counts messages and distinct languages, and says so once the week is over", () => {
        countShown("es"); countShown("ES"); countShown("ja");
        expect(closeWeekIfDue(T0 + WEEK_MS - 1)).toBeNull();
        expect(closeWeekIfDue(T0 + WEEK_MS)).toBe("This week: 3 messages in 2 languages.");
        // A fresh week, counted from zero.
        expect(__weeklyStats()).toMatchObject({ count: 0, langs: [], weekStart: T0 + WEEK_MS });
    });

    it("never shows a note for an empty week", () => {
        expect(closeWeekIfDue(T0 + WEEK_MS)).toBeNull();
        expect(closeWeekIfDue(T0 + 2 * WEEK_MS)).toBeNull();
    });

    it("shows at most one note per 7 days", () => {
        countShown("es");
        expect(closeWeekIfDue(T0 + WEEK_MS)).not.toBeNull();
        countShown("es");
        expect(closeWeekIfDue(T0 + WEEK_MS + 1)).toBeNull();
        expect(closeWeekIfDue(T0 + 2 * WEEK_MS)).toBe("This week: 1 message in 1 language.");
    });

    it("persists the count, so a restart does not lose the week", async () => {
        countShown("de");
        await Promise.resolve();
        __resetWeeklyStats();
        await loadWeeklyStats(T0 + 1);
        expect(__weeklyStats()).toMatchObject({ count: 1, langs: ["de"], weekStart: T0 });
        expect(DataStore.writes).toContain(WEEKLY_KEY);
    });

    it("keeps no message text and no ids, only a count and language codes", async () => {
        countShown("es");
        await Promise.resolve();
        expect(Object.keys((await DataStore.get<object>(WEEKLY_KEY))!).sort())
            .toEqual(["count", "langs", "lastNoteAt", "weekStart"]);
    });
});

describe("review fixes (pure)", () => {
    it("never says 'in 0 languages': a week of translations with no language shows nothing", async () => {
        DataStore.__reset();
        __resetWeeklyStats();
        await loadWeeklyStats(T0);
        countShown(undefined); countShown("");
        expect(closeWeekIfDue(T0 + WEEK_MS)).toBeNull();
    });

    it("counts a lang-less item as a message but not as a language", async () => {
        DataStore.__reset();
        __resetWeeklyStats();
        await loadWeeklyStats(T0);
        countShown(undefined); countShown("es");
        expect(closeWeekIfDue(T0 + WEEK_MS)).toBe("This week: 2 messages in 1 language.");
    });

    it("converts the relay's end onto the local clock using the relay's now", () => {
        // Client clock 3 days fast.
        const local = T0 + 3 * DAY_MS;
        noteServerTrialEnd(T0 + DAY_MS, T0, local);
        expect(freeMode(0, local)).toBe("trial");
        expect(freeMode(0, local + DAY_MS)).toBe("click");
    });

    it("announces a local-only ending only a day after it, and a relay ending at once", () => {
        expect(announceableTrialEnd(T0, T0 + TRIAL_MS + 1)).toBeNull();
        expect(announceableTrialEnd(T0, T0 + TRIAL_MS + DAY_MS)).toBe(T0 + TRIAL_MS);
        noteServerTrialEnd(T0 + 1000, T0, T0);
        expect(announceableTrialEnd(T0, T0 + 999)).toBeNull();
        expect(announceableTrialEnd(T0, T0 + 1000)).toBe(T0 + 1000);
    });

    it("treats the relay's and the local clock's end of one trial as the same ending", () => {
        expect(isNewEnding(T0 + TRIAL_MS, 0)).toBe(true);
        expect(isNewEnding(T0 + TRIAL_MS + 3 * DAY_MS, T0 + TRIAL_MS)).toBe(false);
        expect(isNewEnding(T0 + 3 * TRIAL_MS, T0 + TRIAL_MS)).toBe(true);
    });
});
