const CUSTOM_EMOTE = /<a?:\w+:\d+>/g;
const MENTION = /<[@#][!&]?\d+>/g;
const URL = /https?:\/\/\S+/g;
// Emoji, variation selectors, ZWJ, skin-tone modifiers, regional indicators.
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}]/gu;

export function shouldSkip(text: string, isOwnMessage: boolean): boolean {
    if (isOwnMessage) return true;

    const stripped = text
        .replace(CUSTOM_EMOTE, "")
        .replace(MENTION, "")
        .replace(URL, "")
        .replace(EMOJI, "")
        // Anything left that is only digits, punctuation, or whitespace
        // carries no translatable meaning.
        .replace(/[\d\p{P}\p{S}\s]/gu, "");

    return stripped.length === 0;
}
