/**
 * DISCORD TOKENS STAY DISCORD TOKENS.
 *
 * A message's raw content carries tokens a translator must never touch:
 * custom emoji (<:name:id>, <a:name:id>), user, role and channel mentions,
 * slash-command mentions, timestamps (<t:...>), links, inline code and code
 * blocks, @everyone and @here. Sent as they are, a translator mangles them:
 * a field report had "<:SHAKE:805935394238627880>" come back as ":SHAKE:"
 * and the id of another emoji leak as ":921020213993046066:".
 *
 * So before anything goes to Google or the relay, every token is swapped for
 * an opaque placeholder, ⟦1⟧, ⟦2⟧, ... in order of appearance, and the
 * translation is put back together from the ORIGINAL tokens by number.
 *
 * WHY ⟦n⟧. Mathematical white square brackets around a number: rare enough in
 * chat that a real message almost never contains one (and when it does, the
 * literal is itself masked, so it comes back exactly as written), and kept
 * untouched by Google in every language tried (Polish, Spanish, Japanese,
 * Arabic, Russian, Turkish; see the tests). A translator has no word to
 * translate inside it.
 *
 * Masking is a pure function of the text, so the same text always gives the
 * same placeholders and tokens. That is what lets a stored translation be put
 * back together at render time from the message's own content, without
 * threading a per-message map through the batcher and every engine.
 *
 * WHAT A TRANSLATOR MAY DO WRONG, AND WHAT HAPPENS:
 *   - drops a placeholder: nothing is added back (never in a random place);
 *   - repeats one: each copy is restored;
 *   - reorders them: each is restored where it now stands;
 *   - invents one (⟦9⟧ for a 3-token text): dropped;
 *   - writes a mangled form (":123456789012345678:", ":NAME:", "<:NAME:",
 *     a bare id): turned back into the source's own token when it names one
 *     of the source's custom emoji and that emoji is not already shown,
 *     otherwise removed. A raw snowflake id or a :name: pseudo-emoji that is
 *     not in the source is never shown.
 * The same repair runs on translations stored before this existed, so old
 * cached ":123:" junk is cleaned on render.
 */

export const PH_OPEN = "⟦";   // ⟦
export const PH_CLOSE = "⟧";  // ⟧

/**
 * Every token kind, in one alternation, so the scan is a single left-to-right
 * pass and a token never overlaps another. Code first: a mention inside
 * backticks is code, not a mention. A literal ⟦n⟧ or a lone ⟦ / ⟧ in the
 * source is masked too, so the translation's own placeholders are unambiguous.
 */
const TOKEN = new RegExp(
    [
        "```[\\s\\S]*?```",                      // code block
        "`[^`\\n]+`",                            // inline code
        "<a?:\\w+:\\d+>",                        // custom emoji, animated or not
        "</[^<>:\\n]{1,64}:\\d+>",               // slash-command mention
        "<#\\d+>",                               // channel mention
        "<@&\\d+>",                              // role mention
        "<@!?\\d+>",                             // user mention
        "<t:-?\\d+(?::[a-zA-Z])?>",              // timestamp
        "<https?://[^\\s<>]+>",                  // link without embed
        "https?://[^\\s<>]+",                    // link
        "@everyone", "@here",
        `${PH_OPEN}\\s*\\d+\\s*${PH_CLOSE}`,     // a literal placeholder lookalike
        `[${PH_OPEN}${PH_CLOSE}]`                // a lone bracket
    ].join("|"),
    "g"
);

/** Characters Discord leaves out of a bare link when they end it. */
const LINK_TRAILER = /[.,:;!?'")\]}>]+$/;

export interface Masked {
    /** The text with every token replaced by ⟦n⟧ (1-based). */
    text: string;
    /** tokens[n - 1] is the original text of ⟦n⟧. */
    tokens: string[];
}

export function placeholder(n: number): string {
    return `${PH_OPEN}${n}${PH_CLOSE}`;
}

/** Replace every Discord token in `text` with ⟦n⟧. Pure and total. */
export function maskTokens(text: string): Masked {
    const tokens: string[] = [];
    if (typeof text !== "string" || text === "") return { text: typeof text === "string" ? text : "", tokens };
    const out = text.replace(TOKEN, (match: string) => {
        let token = match;
        let trailer = "";
        if (/^https?:\/\//.test(match)) {
            const t = LINK_TRAILER.exec(match);
            if (t !== null && t.index > 0) {
                token = match.slice(0, t.index);
                trailer = t[0];
            }
        }
        tokens.push(token);
        return placeholder(tokens.length) + trailer;
    });
    return { text: out, tokens };
}

/** Does the text carry any Discord token at all? */
export function hasTokens(text: string): boolean {
    return typeof text === "string" && maskTokens(text).tokens.length > 0;
}

/* -------------------------------------------------------------- restore -- */

const PH_IN_OUTPUT = new RegExp(`${PH_OPEN}\\s*(\\d+)\\s*${PH_CLOSE}`, "g");
/** Full raw Discord tokens a translation might carry (an old path sent them). */
const RAW_IN_OUTPUT = /<a?:\w+:\d+>|<\/[^<>:\n]{1,64}:\d+>|<#\d+>|<@&\d+>|<@!?\d+>|<t:-?\d+(?::[a-zA-Z])?>/g;
/** A custom emoji with its id lost or cut: "<:NAME:", "<a:NAME:>", "<:NAME>". */
const BROKEN_EMOJI = /<a?:(\w+):?\d*>?/g;
/** ":921020213993046066:" : an id written as a pseudo-emoji. */
const ID_PSEUDO = /:(\d{5,}):/g;
/** ":NAME:" : a pseudo-emoji. */
const NAME_PSEUDO = /:(\w+):/g;
/** A bare run of digits long enough to be an id. */
const LONG_DIGITS = /\d{15,}/g;
/** Anything left of a placeholder: "⟦12" cut by a truncation, a lone "⟧". */
const PH_FRAGMENT = new RegExp(`${PH_OPEN}\\s*\\d*\\s*${PH_CLOSE}?|\\d*\\s*${PH_CLOSE}`, "g");

/** Private-use marks: a kept token while the junk passes run. No digits, no brackets. */
const KEEP_OPEN = "";
const KEEP_CLOSE = "";
const DROPPED = "";
const KEPT = new RegExp(`${KEEP_OPEN}(.)${KEEP_CLOSE}`, "gu");

function emojiParts(token: string): { name: string; id: string; } | null {
    const m = /^<a?:(\w+):(\d+)>$/.exec(token);
    return m === null ? null : { name: m[1]!, id: m[2]! };
}

function idOf(token: string): string | null {
    const m = /(\d{5,})>$/.exec(token);
    return m === null ? null : m[1]!;
}

/**
 * Put a translation back together.
 *
 * `out` is what the translator returned (or a stored translation, possibly
 * from before placeholders existed). `masked` is the source as it was sent:
 * its tokens are what the placeholders stand for, and its text says which
 * :name: forms the author really wrote.
 *
 * Returns the translation with every placeholder turned back into its token,
 * every mangled form repaired or removed, and the whitespace left by a removal
 * tidied. Never throws; an empty string means nothing is left to show.
 */
export function restoreTokens(out: string, masked: Masked): string {
    if (typeof out !== "string" || out === "") return "";
    const tokens = masked.tokens;
    const sourceText = masked.text;
    const sourceSet = new Set(tokens);
    const kept: string[] = [];
    const shown = new Set<string>();
    const keep = (token: string): string => {
        kept.push(token);
        shown.add(token);
        return KEEP_OPEN + String.fromCharCode(0xE100 + kept.length - 1) + KEEP_CLOSE;
    };

    const emojiByName = new Map<string, string>();
    const emojiById = new Map<string, string>();
    const ids = new Set<string>();
    for (const t of tokens) {
        const e = emojiParts(t);
        if (e !== null) {
            if (!emojiByName.has(e.name)) emojiByName.set(e.name, t);
            if (!emojiById.has(e.id)) emojiById.set(e.id, t);
        }
        const id = idOf(t);
        if (id !== null) ids.add(id);
    }
    /** The source's emoji, if it is not on screen already; else nothing. */
    const emojiOnce = (token: string | undefined): string => {
        if (token === undefined || shown.has(token)) return DROPPED;
        return keep(token);
    };

    let s = out;
    // 1. The placeholders, by number. A number with no token is dropped.
    s = s.replace(PH_IN_OUTPUT, (_m, n: string) => {
        const token = tokens[Number(n) - 1];
        return token === undefined ? DROPPED : keep(token);
    });
    // 2. Raw tokens: kept only when they are the source's own.
    s = s.replace(RAW_IN_OUTPUT, (token: string) => sourceSet.has(token) ? keep(token) : DROPPED);
    // 3. A custom emoji that lost its id.
    s = s.replace(BROKEN_EMOJI, (_m, name: string) => emojiOnce(emojiByName.get(name)));
    // 4. An id written as a pseudo-emoji.
    s = s.replace(ID_PSEUDO, (m, id: string) => emojiById.has(id) ? emojiOnce(emojiById.get(id)) : (sourceText.includes(m) ? m : DROPPED));
    // 5. A :name: pseudo-emoji the author did not write as text.
    s = s.replace(NAME_PSEUDO, (m, name: string) => {
        if (sourceText.includes(m)) return m;
        const token = emojiByName.get(name);
        return token === undefined ? m : emojiOnce(token);
    });
    // 6. A bare id: one of the source's tokens, or any long digit run the
    //    author did not write.
    s = s.replace(LONG_DIGITS, (digits: string) => {
        if (ids.has(digits)) return DROPPED;
        return sourceText.includes(digits) ? digits : DROPPED;
    });
    // 7. Whatever is left of a placeholder.
    s = s.replace(PH_FRAGMENT, DROPPED);
    // 8. Tidy ONLY where something was dropped (the translator's own spacing
    //    elsewhere is left alone): no doubled space, no space before the
    //    punctuation that followed it, no space at a line's edge. Then the
    //    kept tokens go back in.
    const D = DROPPED;
    s = s
        .replace(new RegExp(`[ \\t]*${D}+[ \\t]*(?=[,.!?;:])`, "g"), "")
        .replace(new RegExp(`(^|\\n)[ \\t]*${D}+[ \\t]*`, "g"), "$1")
        .replace(new RegExp(`[ \\t]*${D}+[ \\t]*(?=\\n|$)`, "g"), "")
        .replace(new RegExp(`([ \\t]*)${D}+([ \\t]*)`, "g"), (_m, a: string, b: string) => (a !== "" || b !== "" ? " " : ""));
    s = s.replace(KEPT, (_m, c: string) => kept[c.charCodeAt(0) - 0xE100] ?? "");
    return s.trim();
}

/**
 * The translation of `source`, put back together. `source` is the text that
 * was sent, before masking (the message content after decode/normalise, or
 * the surface text). Masking it again gives the same placeholders it was sent
 * with, because masking is pure.
 */
export function repairTranslation(translation: string, source: string): string {
    try {
        return restoreTokens(translation, maskTokens(source));
    } catch {
        return typeof translation === "string" ? translation : "";
    }
}

/**
 * Where the tokens are in `text`, as [start, end) offsets. For a cut that must
 * never land inside one (a long text trimmed to fit).
 */
export function tokenSpans(text: string): Array<[number, number]> {
    const spans: Array<[number, number]> = [];
    if (typeof text !== "string") return spans;
    for (const m of text.matchAll(TOKEN)) spans.push([m.index!, m.index! + m[0].length]);
    return spans;
}

/* ------------------------------------------------------- content tokens -- */

/** A custom emoji: decoration. Dropping one loses nothing a reader needs. */
const DECORATIVE = /^<a?:\w+:\d+>$/;
/** A lone ⟦ or ⟧ the author typed: masked only to keep placeholders unambiguous. */
const LONE_BRACKET = new RegExp(`^[${PH_OPEN}${PH_CLOSE}]$`);

/**
 * The source's CONTENT-BEARING tokens, deduplicated, in source order: links,
 * timestamps, user/role/channel/command mentions, @everyone/@here, inline code
 * and code blocks, and a placeholder lookalike the author really typed. These
 * carry meaning a sentence can depend on ("are you coming at ⟦2⟧?"). Custom
 * emoji are decoration and are not listed.
 */
export function contentTokens(source: string): string[] {
    const out: string[] = [];
    for (const t of maskTokens(source).tokens) {
        if (DECORATIVE.test(t) || LONE_BRACKET.test(t)) continue;
        if (!out.includes(t)) out.push(t);
    }
    return out;
}

/**
 * Is `token` in `text` as a whole token? A plain substring test would call
 * https://x/1 kept when only https://x/10 is there: the character after a
 * match must not continue it (a link continues with any non-space, non-<>
 * character, except the punctuation Discord leaves out of a bare link).
 */
function containsToken(text: string, token: string): boolean {
    for (let i = text.indexOf(token); i !== -1; i = text.indexOf(token, i + 1)) {
        const next = text[i + token.length];
        if (next === undefined || /[\s<>]/.test(next)) return true;
        if (/[.,:;!?'")\]}]/.test(next)) {
            const after = text[i + token.length + 1];
            if (after === undefined || /[\s<>.,:;!?'")\]}]/.test(after)) return true;
            continue;
        }
        if (!/^https?:\/\//.test(token) && !/^@(everyone|here)$/.test(token)) return true;
    }
    return false;
}

/**
 * How a token reads as plain text ("@viktor" for a user mention), or null.
 * A translation stored before placeholders existed carries a mention in that
 * readable form; it counts as kept, so the mention is not appended twice.
 */
export type ReadableForm = (token: string) => string | null;

/**
 * The content-bearing tokens of `source` that a restored translation lost, in
 * source order. `restored` is a translation already put back together
 * (restoreTokens / repairTranslation), so a kept token is present verbatim
 * (or, with `readable`, in its readable form).
 */
export function missingContent(restored: string, source: string, readable?: ReadableForm): string[] {
    if (typeof restored !== "string") return contentTokens(source);
    return contentTokens(source).filter(t => {
        if (containsToken(restored, t)) return false;
        let r: string | null = null;
        try { r = readable ? readable(t) : null; } catch { r = null; }
        return !(typeof r === "string" && r !== "" && r !== t && restored.includes(r));
    });
}

/**
 * A restored translation that never loses content: any content-bearing token
 * the translator dropped is appended at the end, in source order, separated
 * by a space. Dropped custom emoji are simply left out. An empty translation
 * stays empty (nothing to append to: the caller shows nothing).
 */
export function withContent(restored: string, source: string, readable?: ReadableForm): string {
    if (typeof restored !== "string" || restored === "") return "";
    const missing = missingContent(restored, source, readable);
    return missing.length === 0 ? restored : `${restored} ${missing.join(" ")}`;
}

/**
 * Should a ≈ line be shown instead of a ✦ line for the same source? Only when
 * ✦ lost a content-bearing token that ≈ kept, and ≈ kept every one of them:
 * a sentence left as "are you coming at the ?" reads worse than Google's
 * rougher line with the time in it. Both arguments are raw stored texts; they
 * are restored here.
 */
export function fastKeepsWhatQualityLost(qualityText: string, fastText: string, source: string, readable?: ReadableForm): boolean {
    try {
        const content = contentTokens(source);
        if (content.length === 0) return false;
        const q = repairTranslation(qualityText, source);
        if (missingContent(q, source, readable).length === 0) return false;
        const f = repairTranslation(fastText, source);
        return f !== "" && missingContent(f, source, readable).length === 0;
    } catch {
        return false;
    }
}
