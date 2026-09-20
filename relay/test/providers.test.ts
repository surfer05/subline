import { describe, it, expect } from "vitest";
import { providers } from "../src/index";
import type { Env } from "../src/codes";

// Only the fields providers() reads; the rest of Env is bindings it never touches.
const env = (over: Partial<Env>): Env => ({ GROQ_KEY: "gk", ADMIN_TOKEN: "a", MODEL: "", ...over } as Env);

describe("providers — which model and key answer a translate request", () => {
    it("Gemini primary + Groq fallback when MODEL is a gemini id AND GEMINI_KEY is set", () => {
        const p = providers(env({ MODEL: "gemini-3.8-flash", GEMINI_KEY: "gem" }));
        expect(p.primary).toEqual({ apiKey: "gem", model: "gemini-3.8-flash" });
        expect(p.fallback).toEqual({ apiKey: "gk", model: "openai/gpt-oss-120b" });
    });

    it("Groq-only on the configured Groq id when MODEL is a Groq model", () => {
        const p = providers(env({ MODEL: "openai/gpt-oss-120b", GEMINI_KEY: "gem" }));
        expect(p.primary).toEqual({ apiKey: "gk", model: "openai/gpt-oss-120b" });
        expect(p.fallback).toBeNull();
    });

    it("MODEL names Gemini but GEMINI_KEY is missing → Groq-only on the FALLBACK model, never a gemini id to Groq", () => {
        // The misconfig that would otherwise fail every call after a deploy.
        const p = providers(env({ MODEL: "gemini-3.8-flash", FALLBACK_MODEL: "openai/gpt-oss-120b" }));
        expect(p.primary).toEqual({ apiKey: "gk", model: "openai/gpt-oss-120b" });
        expect(p.primary.model).not.toMatch(/^gemini/i);
        expect(p.fallback).toBeNull();
    });

    it("no MODEL at all → the Groq default", () => {
        expect(providers(env({ MODEL: "" })).primary).toEqual({ apiKey: "gk", model: "openai/gpt-oss-120b" });
    });
});
