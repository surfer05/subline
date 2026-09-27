/**
 * The language label on a translated line ("≈ es ·"), or null for none.
 *
 * Engines sometimes answer with a code that names no language: "und"
 * (undetermined), "zxx" (no linguistic content), "mul", "mis", an empty
 * string, or something that is not a language code at all. Showing that to a
 * reader ("≈ und ·") says nothing and looks broken, so such a line carries no
 * label. Every place that renders a language label goes through here.
 */

/** ISO 639 special codes that name no single language. */
const NOT_A_LANGUAGE = new Set(["und", "zxx", "mul", "mis", "auto"]);

export function languageLabel(code: unknown): string | null {
    if (typeof code !== "string") return null;
    const c = code.trim();
    if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(c)) return null;
    if (NOT_A_LANGUAGE.has(c.split("-")[0].toLowerCase())) return null;
    try {
        // A well-formed code the runtime cannot name ("qq") is unknown too.
        const name = new Intl.DisplayNames(["en"], { type: "language" }).of(c);
        if (name === undefined || name.toLowerCase() === c.toLowerCase()) return null;
    } catch {
        return null;
    }
    return c;
}
