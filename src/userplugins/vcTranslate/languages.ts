/**
 * The reading languages, for the Target Language dropdown.
 *
 * SINGLE SOURCE OF TRUTH with the installer's language screen. The installer
 * cannot import this file (its tsconfig.build.json compiles only installer/src,
 * and this plugin is built inside a Vencord tree that cannot see installer/),
 * so installer/src/app/language.ts keeps a copy and
 * installer/tests/languageShared.test.ts fails the build if the two differ.
 * Change both together.
 *
 * Values are bare codes ("pt", never "pt-BR"): the engines compare the target
 * against the bare code the detector returns, so a region tag would never match.
 */

export const SUPPORTED_LANGUAGE_CODES: readonly string[] = [
    "af", "am", "ar", "az", "be", "bg", "bn", "bs", "ca", "cs", "cy", "da", "de", "el", "en",
    "eo", "es", "et", "eu", "fa", "fi", "fil", "fr", "ga", "gl", "gu", "ha", "he", "hi", "hr",
    "hu", "hy", "id", "is", "it", "ja", "jv", "ka", "kk", "km", "kn", "ko", "ku", "ky", "lo",
    "lt", "lv", "mk", "ml", "mn", "mr", "ms", "mt", "my", "ne", "nl", "no", "pa", "pl", "ps",
    "pt", "ro", "ru", "si", "sk", "sl", "so", "sq", "sr", "sv", "sw", "ta", "te", "th", "tr",
    "uk", "ur", "uz", "vi", "yo", "zh", "zu"
];

function displayName(inLocale: string, code: string): string | null {
    try {
        const name = new Intl.DisplayNames([inLocale], { type: "language" }).of(code);
        if (name === undefined || name.toLowerCase() === code.toLowerCase()) return null;
        return name.charAt(0).toLocaleUpperCase(inLocale) + name.slice(1);
    } catch {
        return null;
    }
}

/** "Deutsch (German)", "English", or the bare code when ICU cannot name it. */
export function languageLabel(code: string): string {
    const own = displayName(code, code);
    const english = displayName("en", code);
    if (own === null && english === null) return code;
    if (own === null) return english!;
    if (english === null || own === english) return own;
    return `${own} (${english})`;
}

/**
 * Turn a stored value into a code in the list, or null.
 *
 * Earlier builds had a free-text field, so a stored value can be "pt-BR",
 * "PT", "pt_BR" or a name like "English" or "Deutsch". Region tags drop to the
 * primary subtag; a name is matched against the English and native names of
 * every supported code. Anything else is null and stays as it is.
 */
export function normalizeTargetLang(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const primary = trimmed.split(/[-_]/)[0]!.toLowerCase();
    if (SUPPORTED_LANGUAGE_CODES.includes(primary)) return primary;
    const wanted = trimmed.toLowerCase();
    for (const code of SUPPORTED_LANGUAGE_CODES) {
        const names = [displayName("en", code), displayName(code, code)];
        if (names.some(n => n !== null && n.toLowerCase() === wanted)) return code;
    }
    return null;
}

export interface LanguageSelectOption {
    label: string;
    value: string;
}

/**
 * The dropdown rows, sorted by label. A current value that is not in the list
 * (Discord's locale is one we do not list, or an old free-text value that
 * could not be normalised) is added as its own row, so the dropdown always
 * shows what is actually set.
 */
let baseRows: LanguageSelectOption[] | null = null;

export function targetLanguageOptions(current?: unknown): LanguageSelectOption[] {
    if (baseRows === null) {
        baseRows = SUPPORTED_LANGUAGE_CODES.map(code => ({ label: languageLabel(code), value: code }));
        baseRows.sort((a, b) => a.label.localeCompare(b.label, "en"));
    }
    const rows = [...baseRows];
    if (typeof current === "string" && current.trim() !== "" && !SUPPORTED_LANGUAGE_CODES.includes(current)) {
        rows.unshift({ label: languageLabel(current), value: current });
    }
    return rows;
}
