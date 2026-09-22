import { describe, it, expect } from "vitest";
import { providers } from "../src/index";
import type { Env } from "../src/codes";

// Only the fields providers() reads; the rest of Env is bindings it never touches.
const env = (over: Partial<Env>): Env => ({ GROQ_KEY: "gk", ADMIN_TOKEN: "a", MODEL: "", ...over } as Env);

// SHAPE CHANGE: a Provider now carries an explicit `kind`. It has to: OpenRouter
// and Groq both serve "openai/gpt-oss-120b", so the model id can no longer tell
// translate() which endpoint and key to use.
describe("providers — which model and key answer a translate request", () => {
    it("Gemini primary + Groq fallback when MODEL is a gemini id AND GEMINI_KEY is set", () => {
        const p = providers(env({ MODEL: "gemini-3.8-flash", GEMINI_KEY: "gem" }));
        expect(p.primary).toEqual({ kind: "gemini", apiKey: "gem", model: "gemini-3.8-flash" });
        expect(p.fallback).toEqual({ kind: "groq", apiKey: "gk", model: "openai/gpt-oss-120b" });
    });

    it("Groq-only on the configured Groq id when MODEL is a Groq model", () => {
        const p = providers(env({ MODEL: "openai/gpt-oss-120b", GEMINI_KEY: "gem" }));
        expect(p.primary).toEqual({ kind: "groq", apiKey: "gk", model: "openai/gpt-oss-120b" });
        expect(p.fallback).toBeNull();
    });

    it("MODEL names Gemini but GEMINI_KEY is missing → Groq-only on the FALLBACK model, never a gemini id to Groq", () => {
        // The misconfig that would otherwise fail every call after a deploy.
        const p = providers(env({ MODEL: "gemini-3.8-flash", FALLBACK_MODEL: "openai/gpt-oss-120b" }));
        expect(p.primary).toEqual({ kind: "groq", apiKey: "gk", model: "openai/gpt-oss-120b" });
        expect(p.primary.model).not.toMatch(/^gemini/i);
        expect(p.fallback).toBeNull();
    });

    it("no MODEL at all → the Groq default", () => {
        expect(providers(env({ MODEL: "" })).primary)
            .toEqual({ kind: "groq", apiKey: "gk", model: "openai/gpt-oss-120b" });
    });
});

// ---------------------------------------------------------------------------
// The launch routing: Groq's Developer upgrade is closed, so the direct key is
// capped at the free tier. OpenRouter sells the same model pay as you go.
describe("providers: OpenRouter primary, direct Groq key as fallback", () => {
    it("OPENROUTER_KEY set → OpenRouter primary on MODEL, Groq fallback on FALLBACK_MODEL", () => {
        const p = providers(env({ MODEL: "openai/gpt-oss-120b", OPENROUTER_KEY: "or" }));
        expect(p.primary).toEqual({ kind: "openrouter", apiKey: "or", model: "openai/gpt-oss-120b" });
        expect(p.fallback).toEqual({ kind: "groq", apiKey: "gk", model: "openai/gpt-oss-120b" });
    });

    it("the same model id on both providers is routed by kind, not by the id", () => {
        const p = providers(env({ MODEL: "openai/gpt-oss-120b", OPENROUTER_KEY: "or" }));
        expect(p.primary.model).toBe(p.fallback!.model);
        expect(p.primary.kind).toBe("openrouter");
        expect(p.fallback!.kind).toBe("groq");
        expect(p.primary.apiKey).not.toBe(p.fallback!.apiKey);
    });

    it("honours FALLBACK_MODEL for the fallback while the primary keeps MODEL", () => {
        const p = providers(env({ MODEL: "openai/gpt-oss-120b", FALLBACK_MODEL: "llama-3.3-70b", OPENROUTER_KEY: "or" }));
        expect(p.primary.model).toBe("openai/gpt-oss-120b");
        expect(p.fallback).toEqual({ kind: "groq", apiKey: "gk", model: "llama-3.3-70b" });
    });

    it("no OPENROUTER_KEY → Groq-only, exactly as before", () => {
        const p = providers(env({ MODEL: "openai/gpt-oss-120b" }));
        expect(p.primary).toEqual({ kind: "groq", apiKey: "gk", model: "openai/gpt-oss-120b" });
        expect(p.fallback).toBeNull();
    });

    it("OPENROUTER_KEY but no GROQ_KEY → OpenRouter alone, never a fallback holding an empty key", () => {
        const p = providers(env({ MODEL: "openai/gpt-oss-120b", OPENROUTER_KEY: "or", GROQ_KEY: "" }));
        expect(p.primary).toEqual({ kind: "openrouter", apiKey: "or", model: "openai/gpt-oss-120b" });
        expect(p.fallback).toBeNull();
    });

    it("Gemini stays primary when its key is set; OpenRouter becomes its fallback", () => {
        const p = providers(env({ MODEL: "gemini-3.8-flash", GEMINI_KEY: "gem", OPENROUTER_KEY: "or" }));
        expect(p.primary).toEqual({ kind: "gemini", apiKey: "gem", model: "gemini-3.8-flash" });
        // Never a gemini id to an OpenAI-shaped provider: it gets FALLBACK_MODEL.
        expect(p.fallback).toEqual({ kind: "openrouter", apiKey: "or", model: "openai/gpt-oss-120b" });
    });

    it("a gemini MODEL with no GEMINI_KEY still never reaches OpenRouter as a gemini id", () => {
        const p = providers(env({ MODEL: "gemini-3.8-flash", OPENROUTER_KEY: "or" }));
        expect(p.primary).toEqual({ kind: "openrouter", apiKey: "or", model: "openai/gpt-oss-120b" });
        expect(p.primary.model).not.toMatch(/^gemini/i);
        expect(p.fallback).toEqual({ kind: "groq", apiKey: "gk", model: "openai/gpt-oss-120b" });
    });
});
