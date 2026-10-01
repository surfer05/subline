/**
 * How surface translations look.
 *
 * THE TRANSLATION IS ALWAYS VISIBLE. Nobody hovers, so nothing here is a
 * hover-only mark. Where there is room, a small line goes under the original.
 * Where there is not (list rows, titles, tags, the channel header, the reply
 * bar), the TRANSLATED text takes the original's place, prefixed "✦ ", with
 * the original one hover away in the tooltip. It inherits Discord's own
 * styling, so it truncates the same way and no row changes height.
 *
 * TIGHT PLACES ARE ✦ ONLY. They never ask Google, so a long list costs no ≈
 * fan-out. Until ✦ has the text, or when it is skipped (already the reader's
 * language) or failed, Discord's original shows, untouched.
 *
 * LINES: ≈ FIRST, THEN ✦, as under messages. A ≈ line Google itself was unsure of
 * (the same confidence and romanization rules the message subtitle uses) is
 * not shown at all: a paid reader waits the moment for ✦ instead of reading
 * "≈ rough".
 *
 * EVERY COMPONENT FAILS SAFE. Each one is wrapped so a throw renders nothing
 * (see `safe`), and each one renders nothing when there is no service (the
 * plugin is stopped) or nothing to show.
 */

import { React } from "@webpack/common";

import { languageLabel } from "../langLabel";
import { isRomanizedGuess } from "../romanized";
import { MIN_DETECT_CONFIDENCE } from "../types";
import { normalizeSurfaceText, type SurfaceEntry } from "./cache";
import type { SurfaceText } from "./extract";
import { fitLongText, type SurfaceService } from "./service";

let service: SurfaceService | null = null;

/** Set by the plugin's start(), cleared by stop(). */
export function setSurfaceService(next: SurfaceService | null): void {
    service = next;
}

export function currentSurfaceService(): SurfaceService | null {
    return service;
}

export interface SurfaceDisplay {
    glyph: "≈" | "✦";
    lang: string;
    text: string;
}

/**
 * Google's ≈ for `source` is a guess not worth showing: detected below the
 * confidence gate, or romanized text (Arabizi, Hinglish, Darija in Latin
 * letters), which Google translates confidently and wrongly, sometimes with
 * the negation inverted. ONE rule for every surface, roomy or in place.
 */
export function fastUnsure(fast: { lang: string; conf?: number; }, source: string): boolean {
    return (fast.conf !== undefined && fast.conf < MIN_DETECT_CONFIDENCE) || isRomanizedGuess(fast.lang, source);
}

/** What to show for an entry, or null. The ≈ line is held back when it is unsure. */
export function displayFor(entry: SurfaceEntry | null | undefined, source: string): SurfaceDisplay | null {
    if (!entry) return null;
    if (entry.quality) return { glyph: "✦", lang: entry.quality.lang, text: entry.quality.text.trim() };
    const fast = entry.fast;
    if (!fast) return null;
    if (fastUnsure(fast, source)) return null;
    return { glyph: "≈", lang: fast.lang, text: fast.text.trim() };
}

let rtlTarget: () => boolean = () => false;

/** Set by the plugin: whether the reader's language is written right to left. */
export function setSurfaceRtl(isRtl: () => boolean): void {
    rtlTarget = isRtl;
}

/** The direction of a translated line: the reader's language decides it. */
export function translationDir(): "rtl" | "auto" {
    try {
        return rtlTarget() ? "rtl" : "auto";
    } catch {
        return "auto";
    }
}

/** " es" after the glyph, or nothing when the engine named no language ("und"). */
function langSuffix(lang: unknown): string {
    const label = languageLabel(lang);
    return label === null ? "" : ` ${label}`;
}

/** Re-render when any surface translation lands. */
function useSurfaceUpdates(): void {
    const [, force] = React.useReducer((n: number) => n + 1, 0);
    React.useEffect(() => service?.subscribe(force), []);
}

/**
 * A render function that can never break the tree it is placed in: a throw
 * becomes "render nothing" and one debug line. Used in addition to Vencord's
 * own ErrorBoundary around each API slot, because a patched-in call site has
 * no boundary of its own.
 */
export function safe<P>(name: string, render: (props: P) => any, log?: (message: string) => void): (props: P) => any {
    return (props: P) => {
        try {
            return render(props);
        } catch (err) {
            log?.(`[surface] ${name} did not render: ${String(err)}`);
            return null;
        }
    };
}

const LINE_STYLE = { fontSize: "0.85rem", color: "var(--text-muted)", fontStyle: "italic", whiteSpace: "pre-wrap" } as const;

/** Lines that sit away from what they translate say what they are. */
const LABELLED_KINDS = new Set(["reply", "forward", "status", "onboarding"]);

/** Kinds Discord lets run past 2,000 characters (an embed description allows 4,096). */
const LONG_KINDS = new Set(["embed-description", "forward", "rule", "guidelines"]);

/** Shown after a line that covers only the first 4,000 characters of its text. */
export const PARTIAL_NOTE = "Translated the first part. The rest is too long.";

/**
 * Roomy: one small line per foreign text, under the original. A reply or
 * forward preview's line is prefixed with its label, since it does not sit
 * right under the text it translates.
 */
export function SurfaceLines({ texts }: { texts: SurfaceText[]; }) {
    useSurfaceUpdates();
    try {
        if (service === null || !Array.isArray(texts) || texts.length === 0) return null;
        const lines: any[] = [];
        const seen = new Set<string>();
        for (const t of texts) {
            if (seen.has(t.text)) continue;
            seen.add(t.text);
            const long = LONG_KINDS.has(t.kind);
            const shown = displayFor(service.want(t.text, { long }), t.text);
            if (shown === null) continue;
            const partial = long && fitLongText(normalizeSurfaceText(t.text)).partial;
            lines.push(
                <div key={`${t.kind}:${t.text}`} style={LINE_STYLE} data-subline-surface={t.kind}>
                    <span>{LABELLED_KINDS.has(t.kind) ? `${t.label} · ` : ""}{shown.glyph}{langSuffix(shown.lang)} · </span>
                    <span dir={translationDir()}>{shown.text}</span>
                    {partial && <span data-subline-partial="">{" · "}{PARTIAL_NOTE}</span>}
                </div>
            );
        }
        return lines.length === 0 ? null : <div>{lines}</div>;
    } catch {
        return null;
    }
}

/**
 * The translation of a tight text, or null while pending, skipped or failed.
 * ✦ when there is one. Without ✦ (an Automatic owner, or an AI reader whose
 * surface ✦ for today is spent) Google's ≈ is shown in place instead, held
 * back by the same unsure rules as a roomy line.
 */
export function tightTranslation(text: string): { lang: string; text: string; glyph: "✦" | "≈"; } | null {
    if (service === null) return null;
    const entry = service.want(text, { tight: true });
    const q = entry?.quality;
    if (q && q.text.trim() !== "") return { lang: q.lang, text: q.text.trim(), glyph: "✦" };
    if (service.tightQualityOnly()) return null;
    const f = entry?.fast;
    if (!f || f.text.trim() === "") return null;
    if (fastUnsure(f, text)) return null;
    return { lang: f.lang, text: f.text.trim(), glyph: "≈" };
}

const PREFIX_STYLE = { opacity: 0.75 } as const;

/** "✦ translation" (or "≈ translation"), with the original text as its tooltip. */
export function TranslatedInPlace({ original, translation, glyph = "✦" }: { original: string; translation: unknown; glyph?: string; }) {
    return (
        <span title={original} data-subline-surface="in-place">
            <span style={PREFIX_STYLE}>{glyph} </span><span dir={translationDir()}>{translation as any}</span>
        </span>
    );
}

/**
 * Tight: the translation IN PLACE of `original` once ✦ has it, prefixed
 * "✦ ", with `tooltip` (the readable original) as its tooltip. Until then,
 * and when skipped or failed, Discord's `original`, untouched.
 *
 * `render` turns the translated text into what is shown (Discord's own
 * markdown parser, so links, mentions and emoji render). When it returns
 * null (the translation is unsafe to render, or parsing threw), Discord's
 * original stays.
 */
export function TightSwap({ original, text, tooltip, render }: {
    original: unknown; text: string; tooltip?: string; render?: (translation: string) => unknown;
}) {
    useSurfaceUpdates();
    try {
        const t = typeof text === "string" ? tightTranslation(text) : null;
        if (t === null) return (original ?? null) as any;
        const shown = render ? render(t.text) : t.text;
        if (shown === null || shown === undefined) return (original ?? null) as any;
        const swapped = <TranslatedInPlace original={tooltip ?? text} translation={shown} glyph={t.glyph} />;
        // Discord's text sometimes carries a leading space (after an emoji).
        const lead = typeof original === "string" ? /^\s*/.exec(original)![0] : "";
        return lead === "" ? swapped : <>{lead}{swapped}</>;
    } catch {
        return (original ?? null) as any;
    }
}
