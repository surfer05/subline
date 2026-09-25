/**
 * How surface translations look.
 *
 * NEVER REPLACES THE ORIGINAL. Every component here only ADDS: a small line
 * under the original where there is room, or a tiny ✦ with a hover tooltip
 * where there is not (list rows, titles, tags, the channel header). The tight
 * form is inline and one character tall, so no list row changes height.
 *
 * TIGHT MARKS ARE ✦ ONLY. They never ask Google, so a long list costs no ≈
 * fan-out, and they show nothing until ✦ has the text.
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
import type { SurfaceText } from "./extract";
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
const MARK_STYLE = { fontSize: "0.75rem", color: "var(--text-muted)", marginLeft: "4px", cursor: "default", lineHeight: 1 } as const;

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
            const shown = displayFor(service.want(t.text), t.text);
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

/** The tooltip text for a tight marker: "Label: translation" per foreign text. */
export function hintTitle(texts: SurfaceText[]): string | null {
    if (service === null) return null;
    const parts: string[] = [];
    for (const t of texts) {
        // Tight marks are ✦ only: never a ≈ line, never a Google request.
        const entry = service.want(t.text, { tight: true });
        const shown = entry?.quality ? displayFor({ at: entry.at, quality: entry.quality }, t.text) : null;
        if (shown !== null) parts.push(`${t.label} (${shown.glyph} ${shown.lang}): ${shown.text}`);
    }
    return parts.length === 0 ? null : parts.join("\n\n");
}

/**
 * Tight: a tiny ✦ with the translation in its hover tooltip, once ✦ has it.
 * Inline, one character, so a list row keeps its height.
 */
export function SurfaceHint({ texts, before }: { texts: SurfaceText[]; before?: boolean; }) {
    useSurfaceUpdates();
    try {
        const title = Array.isArray(texts) ? hintTitle(texts) : null;
        if (title === null) return null;
        const glyph = "✦";
        const style = before ? { ...MARK_STYLE, marginLeft: 0, marginRight: "4px" } : MARK_STYLE;
        return (
            <span style={style} title={title} aria-label={title} data-subline-surface="hint">
                {glyph}
            </span>
        );
    } catch {
        return null;
    }
}
