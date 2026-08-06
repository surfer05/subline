/**
 * The text a REAL, SUCCESSFUL Gemini call put in its response, captured
 * verbatim against the live `interactions` endpoint with this plugin's exact
 * prompt and this plugin's exact `response_format` schema.
 *
 * Not a hand-written approximation. Shared by llmShared.test.ts and
 * gemini.test.ts so both assert against the identical bytes and cannot drift.
 *
 * It disagrees with the schema we asked for in THREE ways, every one of which
 * used to be fatal:
 *
 *  1. It is wrapped in a ```json markdown fence, so JSON.parse threw on the
 *     first character. native.ts's isRetryable treats "not valid JSON" as
 *     retryable, so the whole batch was sent a second time and then failed.
 *  2. It is a BARE ARRAY, not the `{ "translations": [...] }` object the schema
 *     declares — so even unfenced it hit "missing translations array".
 *  3. `id` is a NUMBER, not a string — so even unfenced AND unwrapped, every
 *     row would have been dropped as an unknown id and every message in the
 *     batch marked failed.
 *
 * The fence is assembled from a repeated character rather than typed inline:
 * three literal backticks inside a source file are the sort of thing an editor,
 * a diff tool or a copy-paste can eat, and a silently-lost fence here would
 * make the fence-stripping tests pass while testing nothing.
 */
const FENCE = "`".repeat(3);

/** Wrap a body in a markdown code fence, optionally language-tagged. */
export const fenced = (body: string, lang = ""): string =>
    FENCE + lang + "\n" + body + "\n" + FENCE;

/** The JSON exactly as the live model emitted it, inside the fence. */
const REAL_GEMINI_BODY_LINES = [
    "[",
    '  { "id": 1, "lang": "ar-MA", "skip": false, "text": "Good on ya for that monster." },',
    '  { "id": 2, "lang": "ar-JO", "skip": false, "text": "I\'m turning Amman upside down looking for you." }',
    "]"
];

/** The response text verbatim: fenced, bare array, numeric ids. */
export const REAL_GEMINI_FENCED_TEXT = fenced(REAL_GEMINI_BODY_LINES.join("\n"), "json");

/**
 * What the two rows above mean, stated independently of the bytes so a test
 * asserting on them is not just re-reading the fixture through JSON.parse.
 */
export const REAL_GEMINI_TRANSLATIONS = [
    "Good on ya for that monster.",
    "I'm turning Amman upside down looking for you."
];
