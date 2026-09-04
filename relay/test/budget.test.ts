import { describe, it, expect } from "vitest";
import { applyBudget } from "../src/budget";

describe("applyBudget — the atomic money guard's arithmetic", () => {
    it("allows a reserve under the ceiling and advances the total", () => {
        expect(applyBudget({ total: 10, frozen: false }, 5, 100)).toEqual({ allowed: true, total: 15, frozen: false });
    });
    it("freezes exactly when the total reaches the ceiling", () => {
        expect(applyBudget({ total: 96, frozen: false }, 4, 100)).toEqual({ allowed: true, total: 100, frozen: true });
    });
    it("refuses once frozen, without advancing", () => {
        expect(applyBudget({ total: 100, frozen: true }, 1, 100)).toEqual({ allowed: false, total: 100, frozen: true });
    });
    it("refuses when already at/over the ceiling even if the frozen flag lagged", () => {
        expect(applyBudget({ total: 100, frozen: false }, 1, 100)).toEqual({ allowed: false, total: 100, frozen: true });
    });
});
