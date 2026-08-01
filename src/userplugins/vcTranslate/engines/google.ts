import type { BatchRequest, Result } from "../types";

const ENDPOINT = "https://translate.googleapis.com/translate_a/single";
const CONCURRENCY = 4;

async function translateOne(
    msg: { id: string; text: string },
    targetLang: string,
    fetchImpl: typeof fetch
): Promise<Result> {
    const url =
        `${ENDPOINT}?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}` +
        `&dt=t&q=${encodeURIComponent(msg.text)}`;

    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`google: HTTP ${res.status}`);

    const body = await res.json();
    // Expected: [[["translated","original",...], ...], null, "<detected lang>"]
    if (!Array.isArray(body) || !Array.isArray(body[0]) || typeof body[2] !== "string") {
        throw new Error("google: unexpected response shape");
    }

    const detected = body[2] as string;
    if (detected === targetLang) return { id: msg.id, skip: true };

    const text = (body[0] as unknown[])
        .map(seg => (Array.isArray(seg) && typeof seg[0] === "string" ? seg[0] : ""))
        .join("")
        .trim();

    if (text.length === 0) throw new Error("google: empty translation");

    return { id: msg.id, lang: detected, text, skip: false };
}

export async function translateWithGoogle(
    req: BatchRequest,
    fetchImpl: typeof fetch = fetch
): Promise<Result[]> {
    const results: Result[] = [];
    for (let i = 0; i < req.messages.length; i += CONCURRENCY) {
        const slice = req.messages.slice(i, i + CONCURRENCY);
        const settled = await Promise.all(
            slice.map(m => translateOne(m, req.targetLang, fetchImpl))
        );
        results.push(...settled);
    }
    return results;
}
