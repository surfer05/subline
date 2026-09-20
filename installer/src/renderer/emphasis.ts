/**
 * The one piece of markup the flow copy is allowed to carry.
 *
 * Screens tell people which control to touch, and the name of that control has
 * to survive being skimmed: "Turn Subline on under App Management" is a
 * sentence, "Turn **Subline** on under **App Management**" is an instruction.
 * The flow (src/app/flow.ts) stays renderer-agnostic and keeps `state.detail` a
 * plain string, so the emphasis travels as two asterisks and is turned into
 * real elements here.
 *
 * This module is the PURE half on purpose: splitting is testable in Node, and
 * the DOM half (`setDetail` in renderer.ts) is four lines of createElement.
 * Nothing anywhere builds HTML from a string.
 */

/** A run of text, or the line break that `\n` stands for. */
export type EmphasisPart = { text: string; strong: boolean } | "br";

const MARK = "**";

/**
 * Split one line. An unclosed `**` is left alone as literal text rather than
 * swallowing the rest of the sentence into a <strong>: copy is written by
 * hand, and a typo should read oddly, not vanish.
 */
function lineParts(line: string): Array<{ text: string; strong: boolean }> {
    const parts: Array<{ text: string; strong: boolean }> = [];
    let rest = line;

    for (;;) {
        const open = rest.indexOf(MARK);
        if (open === -1) break;
        const close = rest.indexOf(MARK, open + MARK.length);
        if (close === -1) break;

        const before = rest.slice(0, open);
        const inside = rest.slice(open + MARK.length, close);
        if (before !== "") parts.push({ text: before, strong: false });
        // `****` emphasises nothing; it must not become an empty <strong>.
        if (inside !== "") parts.push({ text: inside, strong: true });
        rest = rest.slice(close + MARK.length);
    }

    if (rest !== "") parts.push({ text: rest, strong: false });
    return parts;
}

/**
 * `**bold**` becomes a strong run; `\n` becomes a "br". Everything else is
 * plain text, verbatim.
 */
export function emphasisParts(text: string): EmphasisPart[] {
    const out: EmphasisPart[] = [];
    const lines = text.split("\n");

    for (let i = 0; i < lines.length; i++) {
        if (i > 0) out.push("br");
        out.push(...lineParts(lines[i] ?? ""));
    }

    return out;
}
