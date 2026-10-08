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

import { cleanTranslation } from "../customEmoji";
import { IN_PLACE_COPY } from "../upgradeCopy";
import { React } from "@webpack/common";

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
    // Custom emoji junk (ids, :NAME:) never shows, whatever was cached.
    if (entry.quality) return shownOrNull({ glyph: "✦", lang: entry.quality.lang, text: cleanTranslation(entry.quality.text.trim(), source) });
    const fast = entry.fast;
    if (!fast) return null;
    if (fastUnsure(fast, source)) return null;
    return shownOrNull({ glyph: "≈", lang: fast.lang, text: cleanTranslation(fast.text.trim(), source) });
}

/** A line that is empty once cleaned is not shown at all. */
function shownOrNull(d: SurfaceDisplay): SurfaceDisplay | null {
    return d.text.trim() === "" ? null : d;
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

/** Kinds Discord lets run past 2,000 characters (an embed description allows 4,096). */
const LONG_KINDS = new Set(["embed-description", "forward", "rule", "guidelines"]);

/** Shown after a line that covers only the first 4,000 characters of its text. */
export const PARTIAL_NOTE = "Translated the first part. The rest is too long.";

/**
 * Roomy: one small line per foreign text, under the original. The line is
 * just the glyph and the translation ("✦ translation" or "≈ translation"):
 * no kind word ("Status", "About me", ...) and no language code. Where it sits
 * already says what it translates.
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
                    <span>{shown.glyph} </span>
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
    const qText = q ? cleanTranslation(q.text.trim(), text) : "";
    if (q && qText.trim() !== "") return { lang: q.lang, text: qText, glyph: "✦" };
    // While ✦ is the only source, nothing until it lands, EXCEPT a ≈ already
    // cached: it was fetched while ✦ was down (P9), and blanking it the moment
    // ✦ is back would take a readable line away until ✦ answers.
    const f = entry?.fast;
    if (service.tightQualityOnly() && !f) return null;
    if (!f || f.text.trim() === "") return null;
    if (fastUnsure(f, text)) return null;
    const fText = cleanTranslation(f.text.trim(), text);
    if (fText.trim() === "") return null;
    return { lang: f.lang, text: fText, glyph: "≈" };
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

/* ------------------------------------------------- in place, with a toggle -- */

/**
 * Which in-place texts the reader flipped back to the original. Keyed by
 * "user id + text", so a changed status or bio starts over on its
 * translation. In memory only, and bounded: the oldest flips are forgotten
 * first, so many profiles opened in one session cost a fixed amount.
 */
export const MAX_IN_PLACE_FLIPS = 500;
const showingOriginal = new Set<string>();
const flipListeners = new Set<() => void>();

export function inPlaceKey(userId: unknown, text: string): string {
    return `${typeof userId === "string" ? userId : ""}\u0000${text}`;
}

export function isShowingOriginal(key: string): boolean {
    return showingOriginal.has(key);
}

export function flipInPlace(key: string): void {
    if (showingOriginal.has(key)) showingOriginal.delete(key);
    else {
        showingOriginal.add(key);
        while (showingOriginal.size > MAX_IN_PLACE_FLIPS) {
            const oldest = showingOriginal.values().next();
            if (oldest.done) break;
            showingOriginal.delete(oldest.value);
        }
    }
    for (const l of [...flipListeners]) {
        try { l(); } catch { /* a listener never breaks a flip */ }
    }
}

/** For tests: forget every flip. */
export function resetInPlaceFlips(): void {
    showingOriginal.clear();
}

export function inPlaceFlipCount(): number {
    return showingOriginal.size;
}

/**
 * A number that changes whenever a surface translation lands or an in-place
 * toggle flips. Discord's status bubble adds it to the inputs it measures its
 * copies by, so the clamp and the chevron follow what is shown.
 */
export function useSurfaceVersion(): number {
    const [version, bump] = React.useReducer((n: number) => n + 1, 0);
    React.useEffect(() => {
        flipListeners.add(bump);
        const off = service?.subscribe(bump);
        return () => { flipListeners.delete(bump); off?.(); };
    }, []);
    return version;
}

const TOGGLE_STYLE = { cursor: "pointer", opacity: 0.75, marginInlineStart: "0.3em", userSelect: "none", whiteSpace: "nowrap" } as const;

/** Stops an event at the toggle: the bubble's hover, expand and toolbar never see it. */
function stopHere(e: any): void {
    try {
        e?.stopPropagation?.();
    } catch { /* nothing to stop */ }
}

/**
 * The toggle at the end of an in-place text. Its glyph says what shows: the
 * translation's glyph, or ↩ for the original. A click flips it; the click, the
 * press and the key never reach Discord's handlers around it.
 */
export function InPlaceToggle({ flipKey, glyph }: { flipKey: string; glyph: string; }) {
    const original = isShowingOriginal(flipKey);
    const label = original ? IN_PLACE_COPY.showTranslation : IN_PLACE_COPY.showOriginal;
    return (
        <span
            role="button"
            tabIndex={-1}
            data-subline-toggle=""
            aria-label={label}
            title={label}
            style={TOGGLE_STYLE}
            onMouseDown={stopHere}
            onPointerDown={stopHere}
            onKeyDown={stopHere}
            onClick={(e: any) => {
                stopHere(e);
                try { e?.preventDefault?.(); } catch { /* nothing to prevent */ }
                flipInPlace(flipKey);
            }}
        >
            {original ? IN_PLACE_COPY.originalGlyph : glyph}
        </span>
    );
}

/** Re-render when a toggle flips (and when a translation lands). */
function useInPlaceUpdates(): void {
    useSurfaceVersion();
}

/**
 * The status text inside Discord's profile status bubble: the translation IN
 * PLACE of the original, with the toggle at its end. Discord renders this one
 * element in every copy of the bubble (the reference, the clamped and the
 * full measuring copies, and the visible one), so its own clamp, chevron and
 * expand work on whatever shows. Until a translation is there, when it is
 * skipped (already the reader's language) or failed: the original, no toggle.
 */
export function StatusBubbleText({ text, userId }: { text: string; userId?: unknown; }) {
    useInPlaceUpdates();
    try {
        const t = tightTranslation(text);
        if (t === null) return text as any;
        const key = inPlaceKey(userId, text);
        const shown = isShowingOriginal(key) ? text : <span dir={translationDir()}>{t.text}</span>;
        return <>{shown}<InPlaceToggle flipKey={key} glyph={t.glyph} /></>;
    } catch {
        return text as any;
    }
}

const BIO_ROW_STYLE = { display: "flex", alignItems: "flex-end" } as const;
const BIO_TEXT_STYLE = { flex: "1 1 auto", minWidth: 0 } as const;

/**
 * A bio translated IN PLACE: Discord's own bio renderer, handed the
 * translation instead of the original, so Discord's bio markdown (links,
 * mentions, emoji, formatting) renders it exactly as it renders a bio. The
 * toggle sits at the end of the last line. Until a translation is there, when
 * it is skipped or failed: Discord's element, untouched.
 */
export function BioInPlace({ element, bio, userId }: { element: any; bio: string; userId?: unknown; }) {
    useInPlaceUpdates();
    try {
        if (service === null) return element;
        const shown = displayFor(service.want(bio), bio);
        if (shown === null) return element;
        const key = inPlaceKey(userId ?? element?.props?.userId, bio);
        const original = isShowingOriginal(key);
        const body = original ? element : React.cloneElement(element, { userBio: shown.text });
        return (
            <div style={BIO_ROW_STYLE} data-subline-surface="bio-in-place">
                <div style={BIO_TEXT_STYLE} dir={original ? undefined : translationDir()}>{body}</div>
                <InPlaceToggle flipKey={key} glyph={shown.glyph} />
            </div>
        );
    } catch {
        return element;
    }
}
