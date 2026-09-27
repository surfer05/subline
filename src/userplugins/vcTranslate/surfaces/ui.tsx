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

import { isRomanizedGuess } from "../romanized";
import { MIN_DETECT_CONFIDENCE } from "../types";
import type { SurfaceEntry } from "./cache";
import type { SurfaceKind, SurfaceText } from "./extract";
import type { SurfaceService } from "./service";

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

/** What to show for an entry, or null. The ≈ line is held back when it is unsure. */
export function displayFor(entry: SurfaceEntry | null | undefined, source: string): SurfaceDisplay | null {
    if (!entry) return null;
    if (entry.quality) return { glyph: "✦", lang: entry.quality.lang, text: entry.quality.text.trim() };
    const fast = entry.fast;
    if (!fast) return null;
    const unsure = (fast.conf !== undefined && fast.conf < MIN_DETECT_CONFIDENCE) || isRomanizedGuess(fast.lang, source);
    if (unsure) return null;
    return { glyph: "≈", lang: fast.lang, text: fast.text.trim() };
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
            const shown = displayFor(service.want(t.text, { kind: t.kind }), t.text);
            if (shown === null) continue;
            lines.push(
                <div key={`${t.kind}:${t.text}`} style={LINE_STYLE} data-subline-surface={t.kind}>
                    <span>{LABELLED_KINDS.has(t.kind) ? `${t.label} · ` : ""}{shown.glyph} {shown.lang} · </span>
                    <span>{shown.text}</span>
                </div>
            );
        }
        return lines.length === 0 ? null : <div>{lines}</div>;
    } catch {
        return null;
    }
}

/** The ✦ translation of a tight text, or null while pending, skipped or failed. */
export function tightTranslation(text: string, kind?: SurfaceKind): { lang: string; text: string; } | null {
    if (service === null) return null;
    const entry = service.want(text, { tight: true, kind });
    const q = entry?.quality;
    if (!q || q.text.trim() === "") return null;
    return { lang: q.lang, text: q.text.trim() };
}

const PREFIX_STYLE = { opacity: 0.75 } as const;

/** "✦ translation", with the original text as its tooltip. */
export function TranslatedInPlace({ original, translation }: { original: string; translation: unknown; }) {
    return (
        <span title={original} data-subline-surface="in-place">
            <span style={PREFIX_STYLE}>✦ </span>{translation as any}
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
export function TightSwap({ original, text, tooltip, render, kind }: {
    original: unknown; text: string; tooltip?: string; render?: (translation: string) => unknown;
    /** What kind of text this is (see extract.ts), sent to the relay with it. */
    kind?: SurfaceKind;
}) {
    useSurfaceUpdates();
    try {
        const t = typeof text === "string" ? tightTranslation(text, kind) : null;
        if (t === null) return (original ?? null) as any;
        const shown = render ? render(t.text) : t.text;
        if (shown === null || shown === undefined) return (original ?? null) as any;
        const swapped = <TranslatedInPlace original={tooltip ?? text} translation={shown} />;
        // Discord's text sometimes carries a leading space (after an emoji).
        const lead = typeof original === "string" ? /^\s*/.exec(original)![0] : "";
        return lead === "" ? swapped : <>{lead}{swapped}</>;
    } catch {
        return (original ?? null) as any;
    }
}

/**
 * A hook Discord's own component can call (see the status bubble patch): it
 * re-renders that component when any surface translation lands, so layout
 * that Discord measures once (the bubble's height) is measured again.
 */
export function useSurfaceVersion(): number {
    const [version, bump] = React.useReducer((n: number) => n + 1, 0);
    React.useEffect(() => {
        try {
            return service?.subscribe(bump);
        } catch {
            return undefined;
        }
    }, []);
    return version;
}
