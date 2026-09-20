/**
 * The flow's copy carries `**bold**` and `\n`. This is the parser that turns
 * those into parts the renderer appends as real DOM nodes; nothing here, and
 * nothing downstream of here, ever touches innerHTML.
 *
 * The renderer itself is the one module the suite never executes (no DOM), so
 * the splitting lives in its own pure module precisely so it can be tested.
 */

import { describe, expect, it } from "vitest";

import { emphasisParts } from "../src/renderer/emphasis.js";

describe("emphasisParts", () => {
    it("leaves plain text alone", () => {
        expect(emphasisParts("Nothing to see")).toEqual([{ text: "Nothing to see", strong: false }]);
    });

    it("pulls a bold run out of the middle of a sentence", () => {
        expect(emphasisParts("Turn **Subline** on")).toEqual([
            { text: "Turn ", strong: false },
            { text: "Subline", strong: true },
            { text: " on", strong: false }
        ]);
    });

    it("handles several bold runs in one line", () => {
        expect(emphasisParts("**A** and **B**")).toEqual([
            { text: "A", strong: true },
            { text: " and ", strong: false },
            { text: "B", strong: true }
        ]);
    });

    it("turns every newline into a break, blank lines included", () => {
        expect(emphasisParts("one\n\ntwo")).toEqual([
            { text: "one", strong: false },
            "br",
            "br",
            { text: "two", strong: false }
        ]);
    });

    it("keeps an unclosed marker as literal text rather than swallowing the rest", () => {
        expect(emphasisParts("a **b c")).toEqual([{ text: "a **b c", strong: false }]);
    });

    it("never emits an empty part", () => {
        expect(emphasisParts("****")).toEqual([]);
        expect(emphasisParts("")).toEqual([]);
        expect(emphasisParts("**Subline**")).toEqual([{ text: "Subline", strong: true }]);
    });

    it("reproduces the original text when the parts are joined back up", () => {
        const copy = "Turn **Subline** on under **App Management**, then press **Try again**.";
        const flat = emphasisParts(copy)
            .map(part => (part === "br" ? "\n" : part.text))
            .join("");
        expect(flat).toBe(copy.replaceAll("**", ""));
    });
});
