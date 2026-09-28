/**
 * ✦ PREVIEWS for an Automatic owner, and where Upgrade links point.
 *
 * There is no free plan any more (see entitlement.ts): an install is not
 * activated, Automatic, or AI. Automatic owners get three ✦ previews a day on
 * rough ≈ lines: the first few words of the real ✦ translation, cut by the
 * relay and again here. Pure, so the cut can be tested on its own.
 */

/** Where every Upgrade link points when the in-Discord panel cannot open. */
export const PRICING_URL = "https://surfer05.github.io/subline/#pricing";

/* ------------------------------------------------------------ preview -- */

/** How much of a ✦ preview the relay returns (mirrors relay previewText). */
export const PREVIEW_WORDS = 5;
export const PREVIEW_MAX_CHARS = 32;

/**
 * The first few words of a translation, exactly as the relay cuts a ✦ preview.
 *
 * A MIRROR of the relay's own truncation, used twice. (1) On whatever the relay
 * returns in preview mode: a v0.1.6 relay has already cut it, but an older one
 * ignores `mode` and sends the full ✦ line, so the client cuts again and a
 * preview can never show more than this. (2) On the ≈ line, before comparing:
 * if the two cut the same, the preview would show nothing new, so it is not
 * shown.
 *
 * WHAT THIS DOES NOT PROMISE: the relay cuts only v0.1.6 preview requests. A
 * header-less legacy (v0.1.5) ⚡ press still gets the full ✦ line within the
 * 3-a-day taste allowance, as it always did.
 */
export function previewText(text: string): { text: string; truncated: boolean } {
    const words = text.trim().split(/\s+/).filter(Boolean);
    const full = words.join(" ");
    let out = words.slice(0, PREVIEW_WORDS).join(" ");
    const chars = Array.from(out);
    if (chars.length > PREVIEW_MAX_CHARS) out = chars.slice(0, PREVIEW_MAX_CHARS).join("").trimEnd();
    return { text: out, truncated: out !== full };
}

/** Case, spacing and punctuation folded away: "Hello, there." reads as "hello there". */
function normalise(s: string): string {
    return s.toLowerCase().replace(/[\p{P}\p{S}]/gu, " ").replace(/\s+/g, " ").trim();
}

/**
 * Would this ✦ preview tell the reader anything the ≈ line does not already?
 * False when ✦ reads the same as ≈ over the words the preview shows.
 */
export function previewDiffers(preview: string, googleText: string): boolean {
    return normalise(previewText(googleText).text) !== normalise(preview)
        && normalise(googleText) !== normalise(preview);
}
