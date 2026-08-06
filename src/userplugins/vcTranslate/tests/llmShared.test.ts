import { describe, expect, it } from "vitest";

import { extractRows, mapRows, parseJsonText, stripCodeFence } from "../engines/llmShared";
import type { BatchRequest } from "../types";
import { fenced, REAL_GEMINI_FENCED_TEXT, REAL_GEMINI_TRANSLATIONS } from "./fixtures/realGeminiText";
import { calls, __resetLogCalls } from "./stubs/utils-logger";

/**
 * The response-shape hardening, tested where it lives — llmShared is what BOTH
 * engines parse through, so a fix that only reached one of them is the exact
 * bug class this module exists to prevent.
 *
 * The governing rule for every test here: TOLERANT ABOUT PACKAGING, STRICT
 * ABOUT CONTENT. Accepting a fence, a bare array and a numeric id must not
 * also start accepting an id nobody asked for or a row with no usable text.
 * Roughly half of these are guarding that second half.
 */

const req: BatchRequest = {
    messages: [
        { id: "1", author: "kenji", text: "شحال هاد الوحش" },
        { id: "2", author: "ana", text: "قلبت عمان كلها عليك" }
    ],
    context: [],
    targetLang: "en"
};

describe("stripCodeFence", () => {
    it("unwraps a ```json fence", () => {
        expect(stripCodeFence(fenced('{"a":1}', "json"))).toBe('{"a":1}');
    });

    it("unwraps an untagged ``` fence", () => {
        expect(stripCodeFence(fenced('{"a":1}'))).toBe('{"a":1}');
    });

    it("unwraps a fence with surrounding whitespace", () => {
        expect(stripCodeFence("\n  " + fenced('{"a":1}', "JSON") + "  \n")).toBe('{"a":1}');
    });

    it("leaves unfenced text completely alone", () => {
        expect(stripCodeFence('{"a":1}')).toBe('{"a":1}');
        expect(stripCodeFence("sorry, I can't")).toBe("sorry, I can't");
    });

    it("does not unwrap a fence that is only PART of the text", () => {
        // Anchored at both ends: a fence inside a translation is content, not
        // packaging, and eating it would corrupt the payload around it.
        const text = 'prefix ' + fenced('{"a":1}', "json") + ' suffix';
        expect(stripCodeFence(text)).toBe(text);
    });
});

describe("parseJsonText", () => {
    it("parses ordinary unfenced JSON, exactly as it always did", () => {
        expect(parseJsonText('{"translations":[]}', "claude")).toEqual({ translations: [] });
    });

    it("parses a ```json-fenced payload", () => {
        expect(parseJsonText(fenced('{"translations":[]}', "json"), "gemini"))
            .toEqual({ translations: [] });
    });

    it("still throws the attributable error on genuine garbage", () => {
        expect(() => parseJsonText("sorry, I can't help with that", "gemini"))
            .toThrow("gemini: response was not valid JSON");
    });

    it("still throws when the fence wraps something that is not JSON", () => {
        // Unwrapping must rescue a well-formed payload, never manufacture one.
        expect(() => parseJsonText(fenced("not json at all", "json"), "claude"))
            .toThrow("claude: response was not valid JSON");
    });
});

describe("extractRows", () => {
    it("accepts the { translations: [...] } object the schema asks for", () => {
        expect(extractRows({ translations: [{ id: "1" }] }, "claude")).toEqual([{ id: "1" }]);
    });

    it("accepts a bare top-level array", () => {
        expect(extractRows([{ id: "1" }], "gemini")).toEqual([{ id: "1" }]);
    });

    it("accepts an empty array of either shape without throwing", () => {
        expect(extractRows([], "gemini")).toEqual([]);
        expect(extractRows({ translations: [] }, "claude")).toEqual([]);
    });

    it("throws on a shape that is neither, rather than returning nothing", () => {
        // A response we cannot read must not be indistinguishable from one that
        // translated nothing — the latter is a normal, silent outcome.
        expect(() => extractRows({ nope: [] }, "gemini")).toThrow(/missing translations array/);
        expect(() => extractRows(null, "gemini")).toThrow(/missing translations array/);
        expect(() => extractRows("[]", "gemini")).toThrow(/missing translations array/);
        expect(() => extractRows({ translations: "1,2" }, "claude"))
            .toThrow(/missing translations array/);
    });
});

describe("mapRows — numeric id coercion", () => {
    it("matches a NUMERIC id against the request's string id", () => {
        // The live Gemini response numbers its rows even though the schema
        // declares strings. Before the coercion every row was dropped and every
        // message came back failed.
        const rows = [{ id: 1, lang: "ar", text: "hello", skip: false }];
        expect(mapRows(rows, req)).toContainEqual(
            { id: "1", lang: "ar", text: "hello", skip: false }
        );
    });

    it("coerces a numeric id on a skip row too", () => {
        expect(mapRows([{ id: 2, skip: true }], req)).toContainEqual({ id: "2", skip: true });
    });

    it("STILL drops a numeric id that was never requested", () => {
        // The whole value of the coercion is that it does not become a hole:
        // 999 is a number, so it coerces cleanly, and must still be rejected.
        const results = mapRows([{ id: 999, lang: "ar", text: "invented", skip: false }], req);
        expect(results.map(r => r.id)).not.toContain("999");
        expect(results).toEqual([{ id: "1", failed: true }, { id: "2", failed: true }]);
    });

    /**
     * The two tests below are deliberately contrived, and it is load-bearing
     * that they are.
     *
     * Written the obvious way — a junk id against a request whose ids are "1"
     * and "2" — they assert NOTHING: `String(true)` is "true", which is not in
     * the request either, so a rowId that blindly coerced every value would
     * pass them. (Measured: a `String(raw)`-for-anything mutant survived the
     * obvious version of both.) Making the request's OWN ids the strings these
     * values coerce to is what turns them into a real test of "only a string or
     * a safe integer is an id" — under a blanket coercion each row below would
     * match a real message and put a translation on it that the model never
     * actually identified.
     */
    const idsReq = (...ids: string[]): BatchRequest => ({
        messages: ids.map(id => ({ id, author: "a", text: "source " + id })),
        context: [],
        targetLang: "en"
    });

    it("does not coerce a boolean, null or object id into a lookup", () => {
        const target = idsReq("true", "null", "[object Object]");
        const rows = [
            { id: true, lang: "ar", text: "x", skip: false },
            { id: null, lang: "ar", text: "y", skip: false },
            { id: {}, lang: "ar", text: "z", skip: false }
        ];
        expect(mapRows(rows, target)).toEqual([
            { id: "true", failed: true },
            { id: "null", failed: true },
            { id: "[object Object]", failed: true }
        ]);
    });

    it("does not coerce a non-integer or non-finite numeric id", () => {
        const target = idsReq("1.5", "NaN", "Infinity");
        const rows = [
            { id: 1.5, lang: "ar", text: "x", skip: false },
            { id: NaN, lang: "ar", text: "y", skip: false },
            { id: Infinity, lang: "ar", text: "z", skip: false }
        ];
        expect(mapRows(rows, target)).toEqual([
            { id: "1.5", failed: true },
            { id: "NaN", failed: true },
            { id: "Infinity", failed: true }
        ]);
    });
});

describe("mapRows — the safeguards the tolerance must not weaken", () => {
    it("still drops a hallucinated STRING id", () => {
        const results = mapRows([{ id: "999", lang: "ar", text: "invented", skip: false }], req);
        expect(results.map(r => r.id)).not.toContain("999");
    });

    it("still rejects a row with a non-string lang", () => {
        expect(mapRows([{ id: 1, lang: 42, text: "hello", skip: false }], req))
            .toContainEqual({ id: "1", failed: true });
    });

    it("still rejects a row with empty/whitespace text and skip:false", () => {
        expect(mapRows([{ id: 1, lang: "ar", text: "   ", skip: false }], req))
            .toContainEqual({ id: "1", failed: true });
    });

    it("still rejects a row with a non-string text", () => {
        expect(mapRows([{ id: 1, lang: "ar", text: 7, skip: false }], req))
            .toContainEqual({ id: "1", failed: true });
    });

    it("ignores a row that is not an object at all", () => {
        expect(mapRows(["nope", null, 7], req))
            .toEqual([{ id: "1", failed: true }, { id: "2", failed: true }]);
    });

    it("still marks every requested id absent from the response as failed", () => {
        expect(mapRows([{ id: 1, lang: "ar", text: "hello", skip: false }], req))
            .toContainEqual({ id: "2", failed: true });
    });
});

describe("mapRows — hallucinated-id debug logging", () => {
    it("logs nothing by default (debug omitted)", () => {
        __resetLogCalls();
        mapRows([{ id: "999", lang: "ar", text: "invented", skip: false }], req);
        expect(calls).toEqual([]);
    });

    it("logs nothing when debug is explicitly false", () => {
        __resetLogCalls();
        mapRows([{ id: "999", lang: "ar", text: "invented", skip: false }], req, false);
        expect(calls).toEqual([]);
    });

    it("logs the dropped id when debug is true", () => {
        __resetLogCalls();
        mapRows([{ id: "999", lang: "ar", text: "invented", skip: false }], req, true);
        expect(calls).toHaveLength(1);
        expect(calls[0].level).toBe("debug");
        expect(String(calls[0].args[0])).toContain("999");
        expect(String(calls[0].args[0])).toContain("hallucinated");
    });

    it("does not log for a row with no id at all — only a REAL hallucinated id", () => {
        __resetLogCalls();
        mapRows(["nope", null, 7], req, true);
        expect(calls).toEqual([]);
    });

    it("does not log anything for ordinary valid rows", () => {
        __resetLogCalls();
        mapRows([{ id: "1", lang: "ar", text: "hello", skip: false }], req, true);
        expect(calls).toEqual([]);
    });
});

describe("the VERBATIM live Gemini response", () => {
    it("parses end to end: fenced, bare array, numeric ids", () => {
        // All three deviations at once, on the exact bytes the live API
        // returned. This is the case that produced zero LLM translations.
        const rows = extractRows(parseJsonText(REAL_GEMINI_FENCED_TEXT, "gemini"), "gemini");
        const results = mapRows(rows, req);

        expect(results).toEqual([
            { id: "1", lang: "ar-MA", text: REAL_GEMINI_TRANSLATIONS[0], skip: false },
            { id: "2", lang: "ar-JO", text: REAL_GEMINI_TRANSLATIONS[1], skip: false }
        ]);
        expect(results.some(r => "failed" in r)).toBe(false);
    });
});
