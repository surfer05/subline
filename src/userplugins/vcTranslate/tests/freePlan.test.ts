import { describe, expect, it, beforeEach } from "vitest";

import { contentHash, loadPreviewLedger, MAX_PREVIEWS_KEPT, parseLedger, PREVIEW_LEDGER_KEY, PRICING_URL, rememberPreview, type PreviewResult } from "../freePlan";
import {
    __resetWeeklyStats, __weeklyStats, closeWeekIfDue, countShown, loadWeeklyStats, WEEK_MS, WEEKLY_KEY,
    weeklyNoteText
} from "../weeklyNote";
import * as DataStore from "./stubs/api-datastore";

const T0 = Date.UTC(2026, 8, 25, 12, 0, 0);

describe("the copy", () => {
    it("points upgrade links at the site, and uses no em dash", () => {
        expect(PRICING_URL).toBe("https://subline.page/#pricing");
        expect(weeklyNoteText(12, 3)).not.toContain("—");
    });
});

describe("the ✦ preview ledger", () => {
    beforeEach(() => DataStore.__reset());

    it("tells an edit apart, and stores no message text", async () => {
        expect(contentHash("hola")).toBe(contentHash("hola"));
        expect(contentHash("hola")).not.toBe(contentHash("hola!"));
        const m = new Map<string, PreviewResult>();
        rememberPreview(m, "1", { text: "hi", lang: "es", src: contentHash("hola secreto") });
        await Promise.resolve();
        expect(JSON.stringify(await DataStore.get(PREVIEW_LEDGER_KEY))).not.toContain("secreto");
    });

    it("survives a restart, and keeps the full text", async () => {
        const long = "word ".repeat(400).trim();
        const m = new Map<string, PreviewResult>();
        rememberPreview(m, "1", { text: long, src: "x" });
        rememberPreview(m, "2", { text: null, src: "y" });
        await Promise.resolve();
        const back = new Map<string, PreviewResult>();
        await loadPreviewLedger(back);
        expect(back.get("1")).toEqual({ text: long, src: "x" });
        expect(back.get("2")).toEqual({ text: null, src: "y" });
    });

    it("keeps the newest few hundred, oldest first out", () => {
        const m = new Map<string, PreviewResult>();
        for (let i = 0; i < MAX_PREVIEWS_KEPT + 5; i++) rememberPreview(m, String(i), { text: "t", src: "s" });
        expect(m.size).toBe(MAX_PREVIEWS_KEPT);
        expect(m.has("0")).toBe(false);
        expect(m.has(String(MAX_PREVIEWS_KEPT + 4))).toBe(true);
    });

    it("drops anything malformed", () => {
        expect(parseLedger("junk")).toEqual([]);
        expect(parseLedger([["1", { text: 5, src: "s" }], ["", { text: "a", src: "s" }], ["2", { text: "a" }], ["3", { text: "ok", src: "s", lang: 7 }]]))
            .toEqual([["3", { text: "ok", src: "s" }]]);
    });

    it("keeps the reading language a preview was made in", () => {
        expect(parseLedger([["1", { text: "a", src: "s", targetLang: "es" }], ["2", { text: "b", src: "s", targetLang: 3 }]]))
            .toEqual([["1", { text: "a", src: "s", targetLang: "es" }], ["2", { text: "b", src: "s" }]]);
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
