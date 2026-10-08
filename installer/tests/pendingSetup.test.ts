import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearPendingLanguage, PENDING_SETUP_FILENAME, PENDING_SETUP_MAX_AGE_MS, readPendingLanguage, writePendingLanguage } from "../src/app/pendingSetup.js";
import { readPriorUse } from "../src/app/language.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "subline-pending-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("the pending reading language (field test I6)", () => {
    it("round-trips, and is cleared", () => {
        expect(writePendingLanguage(dir, "tr", 1_000).ok).toBe(true);
        expect(readPendingLanguage(dir, 2_000)).toBe("tr");
        clearPendingLanguage(dir);
        expect(readPendingLanguage(dir, 2_000)).toBeNull();
    });
    it("expires, and never reads a future or unknown entry", () => {
        writePendingLanguage(dir, "tr", 1_000);
        expect(readPendingLanguage(dir, 1_000 + PENDING_SETUP_MAX_AGE_MS + 1)).toBeNull();
        expect(readPendingLanguage(dir, 500)).toBeNull();
        writeFileSync(join(dir, PENDING_SETUP_FILENAME), JSON.stringify({ language: "xx-not-a-language", at: 1_000 }));
        expect(readPendingLanguage(dir, 2_000)).toBeNull();
        writeFileSync(join(dir, PENDING_SETUP_FILENAME), "{ not json");
        expect(readPendingLanguage(dir, 2_000)).toBeNull();
    });
    it("lives outside Vencord's settings, so an abandoned run is never 'prior use'", () => {
        writePendingLanguage(dir, "tr", 1_000);
        expect(readPriorUse(join(dir, "settings.json"))).toBe(false);
    });
    it("no product folder: nothing to read or write", () => {
        expect(readPendingLanguage(null, 1)).toBeNull();
        expect(writePendingLanguage(null, "tr", 1).ok).toBe(true);
    });
});
