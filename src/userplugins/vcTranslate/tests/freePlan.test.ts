import { describe, expect, it, beforeEach } from "vitest";

import { previewDiffers, previewText, PRICING_URL } from "../freePlan";
import {
    __resetWeeklyStats, __weeklyStats, closeWeekIfDue, countShown, loadWeeklyStats, WEEK_MS, WEEKLY_KEY,
    weeklyNoteText
} from "../weeklyNote";
import * as DataStore from "./stubs/api-datastore";

const T0 = Date.UTC(2026, 8, 25, 12, 0, 0);

describe("the copy", () => {
    it("points upgrade links at the site, and uses no em dash", () => {
        expect(PRICING_URL).toBe("https://surfer05.github.io/subline/#pricing");
        expect(weeklyNoteText(12, 3)).not.toContain("—");
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
});
