import { describe, expect, it } from "vitest";

import { languageLabel } from "../langLabel";

describe("languageLabel", () => {
    it("keeps real language codes", () => {
        for (const c of ["es", "de", "pt", "zh", "fil", "pt-BR"]) expect(languageLabel(c), c).toBe(c);
    });
    it("drops codes that name no language", () => {
        for (const c of ["und", "zxx", "mul", "mis", "auto", "UND", "und-Latn", "", "  ", "qq", "12", "english", null, undefined, 5]) {
            expect(languageLabel(c), String(c)).toBeNull();
        }
    });
});
