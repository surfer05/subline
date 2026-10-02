/**
 * CUSTOM EMOJI NEVER REACH A TRANSLATOR, AND NEVER COME BACK AS TEXT.
 *
 * A Discord custom emoji sits in a message's raw content as `<:name:id>` (or
 * `<a:name:id>` when animated), with a snowflake id. Sent to a translator in
 * any form, it comes back as junk: a raw id (":921020213993046066:"), a
 * pseudo-emoji (":SHAKE:"), or a half token. An emoji carries no words to
 * translate, so the simple rule is:
 *
 *  1. `dropCustomEmoji` takes every custom emoji out of the text BEFORE it is
 *     sent (messages, ⚡, previews, context, surfaces, the reply bar), and
 *     tidies the spaces it leaves behind. The original message, with its
 *     emoji, is still right there above the translation.
 *  2. `cleanTranslation` is the defensive pass on what is SHOWN: whatever a
 *     translator returns, and whatever the cache holds from before this rule
 *     existed. It strips custom emoji tokens, `:<snowflake digits>:`, bare
 *     snowflake ids that are one of the source's emoji ids, and `:NAME:`
 *     pseudo-emoji whose NAME is one of the source's emoji names. A long
 *     number the author typed, or a `:word:` that is not one of the source's
 *     emoji, is real text and stays.
 *
 * Translation lines stay plain text: nothing here renders markup.
 */

/** A custom emoji token, static or animated. Groups: 1 = name, 2 = id. */
const EMOJI_RE = /<a?:(\w+):(\d+)>/g;

/**
 * A snowflake-length digit run between colons. At least 15 digits, so a
 * clock time like "12:30:45" (":30:") is never taken for an emoji id.
 */
const COLON_ID = ":\\d{15,}:";

/** Anything left after removal: tidy runs of spaces and the ends of lines. */
function tidy(text: string): string {
    return text
        .replace(/[ \t]{2,}/g, " ")
        .replace(/^[ \t]+|[ \t]+$/gm, "")
        .replace(/^\n+|\n+$/g, "");
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Remove every match of `junk` (a regex SOURCE), together with the spaces
 * around it, leaving one space where a word gap was. Text with no match is
 * returned exactly as it was, so a line without junk is never re-spaced.
 */
function removeJunk(text: string, junk: string): string {
    const run = new RegExp(`[ \\t]*(?:${junk})(?:[ \\t]*(?:${junk}))*[ \\t]*`, "gi");
    if (!run.test(text)) return text;
    run.lastIndex = 0;
    return tidy(text.replace(run, " "));
}

/** The custom emoji in `source`: their names and ids. */
export function sourceEmoji(source: string): { names: Set<string>; ids: Set<string>; } {
    const names = new Set<string>();
    const ids = new Set<string>();
    if (typeof source !== "string") return { names, ids };
    for (const m of source.matchAll(EMOJI_RE)) {
        names.add(m[1]!.toLowerCase());
        ids.add(m[2]!);
    }
    return { names, ids };
}

/**
 * `text` with every custom emoji removed and the spaces around them tidied
 * (no doubled spaces, none at the start or end of a line; line breaks kept).
 * An emoji-only text becomes "". Text without a custom emoji is returned
 * unchanged.
 */
export function dropCustomEmoji(text: string): string {
    if (typeof text !== "string" || text.indexOf("<") === -1) return text;
    return removeJunk(text, EMOJI_RE.source);
}

/**
 * A translation as it may be shown: custom emoji junk removed, judged against
 * the SOURCE text it translates (raw content, emoji included). See the header
 * for exactly what goes and what stays.
 */
export function cleanTranslation(translation: string, source: string): string {
    if (typeof translation !== "string" || translation === "") return translation;
    const { names, ids } = sourceEmoji(source);
    const parts = [EMOJI_RE.source, COLON_ID];
    if (names.size > 0) parts.push(`:(?:${[...names].map(escapeRe).join("|")}):`);
    if (ids.size > 0) parts.push(`(?<!\\d)(?:${[...ids].join("|")})(?!\\d)`);
    return removeJunk(translation, parts.join("|"));
}
