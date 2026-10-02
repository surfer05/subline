import { Parser } from "@webpack/common";

/**
 * A translated line as Discord would paint it: custom emoji as images,
 * mentions as mentions, links as links, code as code.
 *
 * In place of Discord's own text (the reply bar, a topic, a voice status) the
 * line always goes through the same parser Discord used, as it always has
 * (`always`). A line of our own (under a message, a profile or an embed) goes
 * through Discord's markdown parser only when it carries one of those. A plain line stays the plain string it always was, so asterisks or
 * underscores a translator wrote are not suddenly read as formatting. If the
 * parser is missing (not loaded yet) or throws, the plain text is shown: a
 * line is never lost to rendering.
 */
const NEEDS_PARSE = new RegExp([
    "<a?:\\w+:\\d+>",
    "</[^<>:\\n]{1,64}:\\d+>",
    "<#\\d+>",
    "<@&\\d+>",
    "<@!?\\d+>",
    "<t:-?\\d+(?::[a-zA-Z])?>",
    "https?://",
    "`"
].join("|"));

export function needsParse(text: string): boolean {
    return typeof text === "string" && NEEDS_PARSE.test(text);
}

export function renderTranslated(
    text: string,
    opts: { channelId?: string | null; parse?: (text: string) => unknown; always?: boolean; } = {}
): unknown {
    if (typeof text !== "string" || text === "") return text;
    if (!opts.always && !needsParse(text)) return text;
    try {
        const out = opts.parse
            ? opts.parse(text)
            : Parser.parse(text, true, typeof opts.channelId === "string" ? { channelId: opts.channelId } : {});
        return out === null || out === undefined ? text : out;
    } catch {
        return text;
    }
}
