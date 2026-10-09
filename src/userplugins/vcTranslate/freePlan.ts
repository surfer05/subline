import * as DataStore from "@api/DataStore";

/**
 * ✦ PREVIEWS for an Automatic owner, and where Upgrade links point.
 *
 * There is no free plan any more (see entitlement.ts): an install is not
 * activated, Automatic, or AI. Automatic owners get five ✦ previews a day: the
 * FULL ✦ translation of one message, shown in place of its ≈ line with an
 * "Add AI" link. One message text never costs more than one preview, so every
 * preview shown is remembered here, across restarts. An edit is new text:
 * it is offered again and costs one more.
 */

/** Where every Upgrade link points when the in-Discord panel cannot open. */
export const PRICING_URL = "https://subline.page/#pricing";

/* ------------------------------------------------------------ preview -- */

/**
 * One message's ✦ preview. `text` is the full ✦ translation, or null when ✦
 * said there is nothing to translate. `src` is a hash of the message content
 * it was made from: an edit makes it stale (see contentHash).
 */
export interface PreviewResult {
    text: string | null;
    lang?: string;
    src: string;
    /** The reading language it was made in. Shown only while that is still
     *  the reading language. A legacy row has none and is never shown. */
    targetLang?: string;
}

/** Where the previews shown are kept. */
export const PREVIEW_LEDGER_KEY = "VcTranslate_previews";
/** The newest this many are kept; the oldest go first. */
export const MAX_PREVIEWS_KEPT = 200;

/**
 * FNV-1a over the content, as 8 hex digits. Only tells "this is the text the
 * preview was made from" apart from an edit, so the message text itself is
 * never stored with the preview.
 */
export function contentHash(s: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
}

/** A stored ledger, read defensively: anything malformed is dropped. */
export function parseLedger(raw: unknown): [string, PreviewResult][] {
    if (!Array.isArray(raw)) return [];
    const out: [string, PreviewResult][] = [];
    for (const row of raw) {
        if (!Array.isArray(row) || row.length !== 2) continue;
        const [id, p] = row as [unknown, any];
        if (typeof id !== "string" || id === "" || !p || typeof p !== "object") continue;
        if (typeof p.src !== "string") continue;
        if (p.text !== null && typeof p.text !== "string") continue;
        const lang = typeof p.lang === "string" ? p.lang : undefined;
        const targetLang = typeof p.targetLang === "string" && p.targetLang !== "" ? p.targetLang : undefined;
        out.push([id, { text: p.text, src: p.src, ...(lang !== undefined ? { lang } : {}), ...(targetLang !== undefined ? { targetLang } : {}) }]);
    }
    return out.slice(-MAX_PREVIEWS_KEPT);
}

/** Fill `into` from the stored ledger. A read failure leaves it empty. */
export async function loadPreviewLedger(into: Map<string, PreviewResult>): Promise<void> {
    let raw: unknown;
    try { raw = await DataStore.get<unknown>(PREVIEW_LEDGER_KEY); } catch { return; }
    for (const [id, p] of parseLedger(raw)) into.set(id, p);
}

/** Add one preview, drop the oldest past the limit, and store the lot. */
export function rememberPreview(map: Map<string, PreviewResult>, id: string, p: PreviewResult): void {
    map.delete(id);
    map.set(id, p);
    while (map.size > MAX_PREVIEWS_KEPT) {
        const oldest = map.keys().next();
        if (oldest.done) break;
        map.delete(oldest.value);
    }
    void DataStore.set(PREVIEW_LEDGER_KEY, [...map.entries()]).catch(() => { });
}
