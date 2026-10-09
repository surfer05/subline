// Tests never reach the network: a real Dodo, Groq or Cloudflare call from a
// test would be a call to production with a fake key. A test that needs a
// response stubs fetch itself (vi.stubGlobal); vi.unstubAllGlobals() returns
// here, never to the real fetch.
globalThis.fetch = (async (input: any) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    throw new Error(`network disabled in tests: ${String(url).split("?")[0]}`);
}) as typeof fetch;
