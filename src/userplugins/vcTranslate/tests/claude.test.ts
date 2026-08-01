import { describe, expect, it, vi } from "vitest";
import { buildPrompt, parseClaudeResponse, translateWithClaude } from "../engines/claude";
import type { BatchRequest } from "../types";

const req: BatchRequest = {
    messages: [
        { id: "10", author: "kenji", text: "今日はやめとく" },
        { id: "11", author: "ana", text: "ok cool" }
    ],
    context: [{ author: "sam", text: "are we playing tonight?" }],
    targetLang: "en"
};

const apiResponse = (payload: unknown) => ({
    ok: true,
    json: async () => ({ content: [{ type: "text", text: JSON.stringify(payload) }] })
});

describe("buildPrompt", () => {
    it("includes every message with its id and author", () => {
        const prompt = buildPrompt(req);
        expect(prompt).toContain("今日はやめとく");
        expect(prompt).toContain("kenji");
        expect(prompt).toContain("10");
    });

    it("includes context messages", () => {
        expect(buildPrompt(req)).toContain("are we playing tonight?");
    });

    it("names the target language", () => {
        expect(buildPrompt(req)).toContain("en");
    });

    it("omits the context section entirely when there is none", () => {
        const prompt = buildPrompt({ ...req, context: [] });
        expect(prompt).not.toContain("Recent conversation");
    });
});

describe("parseClaudeResponse", () => {
    it("maps translations and skips", () => {
        const body = {
            content: [{
                type: "text",
                text: JSON.stringify({
                    translations: [
                        { id: "10", lang: "ja", text: "I'll skip today", skip: false },
                        { id: "11", lang: "en", text: "", skip: true }
                    ]
                })
            }]
        };
        expect(parseClaudeResponse(body, req)).toEqual([
            { id: "10", lang: "ja", text: "I'll skip today", skip: false },
            { id: "11", skip: true }
        ]);
    });

    it("drops entries whose id was not in the request", () => {
        const body = {
            content: [{
                type: "text",
                text: JSON.stringify({
                    translations: [
                        { id: "10", lang: "ja", text: "ok", skip: false },
                        { id: "999", lang: "ja", text: "hallucinated", skip: false }
                    ]
                })
            }]
        };
        expect(parseClaudeResponse(body, req).map(r => r.id)).toEqual(["10"]);
    });

    it("throws when the response contains no text block", () => {
        expect(() => parseClaudeResponse({ content: [] }, req)).toThrow();
    });

    it("throws when the text block is not valid JSON", () => {
        const body = { content: [{ type: "text", text: "sorry, I can't" }] };
        expect(() => parseClaudeResponse(body, req)).toThrow();
    });

    it("throws when translations is missing", () => {
        const body = { content: [{ type: "text", text: JSON.stringify({ nope: [] }) }] };
        expect(() => parseClaudeResponse(body, req)).toThrow();
    });
});

describe("translateWithClaude", () => {
    it("sends the correct model, headers, and no effort/thinking params", async () => {
        const fetchImpl = vi.fn().mockResolvedValue(
            apiResponse({ translations: [{ id: "10", lang: "ja", text: "ok", skip: false }] })
        );
        await translateWithClaude(req, "sk-test", fetchImpl as any);

        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toBe("https://api.anthropic.com/v1/messages");
        expect(init.headers["x-api-key"]).toBe("sk-test");
        expect(init.headers["anthropic-version"]).toBe("2023-06-01");

        const sent = JSON.parse(init.body);
        expect(sent.model).toBe("claude-haiku-4-5");
        expect(sent.output_config.format.type).toBe("json_schema");
        expect(sent).not.toHaveProperty("thinking");
        expect(sent.output_config).not.toHaveProperty("effort");
    });

    it("throws on a non-OK status", async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: false, status: 401, text: async () => "unauthorized"
        });
        await expect(translateWithClaude(req, "bad", fetchImpl as any)).rejects.toThrow(/401/);
    });

    it("never includes the api key in a thrown error", async () => {
        const key = "sk-secret-value-do-not-leak";
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: false, status: 401, text: async () => "unauthorized"
        });

        // NB: `.rejects.toThrow(expect.not.stringContaining(...))` does NOT work
        // here — vitest applies the matcher to the Error object, not its message,
        // so a negated string matcher passes unconditionally. Inspect the caught
        // error explicitly instead.
        let caught: unknown;
        try {
            await translateWithClaude(req, key, fetchImpl as any);
        } catch (e) {
            caught = e;
        }

        expect(caught).toBeInstanceOf(Error);
        const err = caught as Error;
        expect(err.message).toContain("401");
        expect(err.message).not.toContain(key);
        expect(err.stack ?? "").not.toContain(key);
        expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(key);
    });
});
