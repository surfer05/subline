/**
 * The reading-language step (spec §3a).
 *
 * Three rules, all of them from the spec, all of them load-bearing:
 *
 *  1. **Names in their own language.** "Türkçe", not "Turkish". The person most
 *     likely to change this setting is the one least able to read an English
 *     label, so an English list would fail exactly the user the feature exists
 *     for. `Intl.DisplayNames` gives us the endonym for free.
 *  2. **A bare code, never a region.** The engines compare `targetLang` against
 *     the bare code the detector returns, so `pt-BR` would never match `pt` and
 *     every message in the reader's own language would be pointlessly
 *     translated. `normalizeLangCode` is the single place that truncation
 *     happens.
 *  3. **Pre-filled from Discord, confirmed rather than inherited.** The plugin
 *     already defaults from `LocaleStore`, but silently — and a wrong guess
 *     leaves the user stuck. We read the same locale Discord stores on disk and
 *     show it as an answer they can change in one click.
 *
 * The setting itself belongs to Vencord, not to us: `targetLang` is a real
 * Vencord plugin setting living at `plugins.VcTranslate.targetLang` in
 * Vencord's own `settings.json`. So this module MERGES into that file rather
 * than writing it — clobbering it would wipe the settings of a user who already
 * had Vencord, which is precisely the reputational failure spec §1 refuses.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { err, fsError, ok } from "../patcher/result.js";
/** The plugin's Vencord name — `definePlugin({ name: "VcTranslate" })`. */
export const PLUGIN_SETTINGS_KEY = "VcTranslate";
/** The setting this step writes. */
export const TARGET_LANG_KEY = "targetLang";
/**
 * The languages offered in the picker.
 *
 * Deliberately a curated list rather than "every tag ICU knows": ICU knows
 * hundreds, most of which neither engine translates, and a picker that offers a
 * language the product cannot deliver is a worse lie than a short list. These
 * are the bare codes both engines handle, which is the intersection that
 * matters.
 */
export const SUPPORTED_LANGUAGE_CODES = [
    "af", "am", "ar", "az", "be", "bg", "bn", "bs", "ca", "cs", "cy", "da", "de", "el", "en",
    "eo", "es", "et", "eu", "fa", "fi", "fil", "fr", "ga", "gl", "gu", "ha", "he", "hi", "hr",
    "hu", "hy", "id", "is", "it", "ja", "jv", "ka", "kk", "km", "kn", "ko", "ku", "ky", "lo",
    "lt", "lv", "mk", "ml", "mn", "mr", "ms", "mt", "my", "ne", "nl", "no", "pa", "pl", "ps",
    "pt", "ro", "ru", "si", "sk", "sl", "so", "sq", "sr", "sv", "sw", "ta", "te", "th", "tr",
    "uk", "ur", "uz", "vi", "yo", "zh", "zu"
];
/**
 * Reduce any locale tag to the bare primary subtag.
 *
 * Returns `null` rather than a guess for anything that is not a language tag,
 * because an invented code would be written into a setting and then silently
 * fail to match anything for the life of the install.
 */
export function normalizeLangCode(input) {
    if (typeof input !== "string")
        return null;
    const trimmed = input.trim();
    if (trimmed.length === 0)
        return null;
    // Discord writes `en-US`; some tooling writes `en_US`.
    const primary = trimmed.split(/[-_]/)[0] ?? "";
    if (!/^[A-Za-z]{2,3}$/.test(primary))
        return null;
    return primary.toLowerCase();
}
/**
 * The language's name in itself, or `null` when ICU does not know the code.
 *
 * `Intl.DisplayNames` echoes an unknown code straight back, so "the answer
 * equals the question" is how we detect ignorance. Returning `null` lets the
 * caller drop the entry instead of showing a picker row that reads "xx".
 */
export function endonymOf(code) {
    let name;
    try {
        name = new Intl.DisplayNames([code], { type: "language" }).of(code);
    }
    catch {
        return null;
    }
    if (name === undefined || name.toLowerCase() === code.toLowerCase())
        return null;
    // ICU returns the linguistically correct casing ("português"), which reads
    // as a typo in a list. Upper-casing with the language's OWN locale keeps
    // Turkish dotted-I and friends correct, and is a no-op for scripts without
    // case.
    return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
}
function englishNameOf(code) {
    try {
        return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
    }
    catch {
        return code;
    }
}
/**
 * Is this a language at all?
 *
 * `normalizeLangCode` is deliberately syntactic — it takes the primary subtag of
 * whatever it is handed — and that is not enough on its own: "not-a-language"
 * normalizes to "not", which is the right shape and no language. Writing that
 * into `targetLang` produces an install that translates every message into
 * nothing, forever, with no error anywhere. ICU echoing an unknown code back
 * unchanged is the check, and it is the same one the picker uses to decide which
 * rows it can render.
 */
export function isKnownLanguage(code) {
    const bare = normalizeLangCode(code);
    return bare !== null && endonymOf(bare) !== null;
}
/**
 * The picker's rows, sorted by endonym in the user's own collation.
 *
 * Any code ICU cannot name is dropped rather than shown raw — see `endonymOf`.
 */
export function languageOptions(codes = SUPPORTED_LANGUAGE_CODES) {
    const options = [];
    for (const raw of codes) {
        const code = normalizeLangCode(raw);
        if (code === null)
            continue;
        if (options.some(option => option.code === code))
            continue;
        const endonym = endonymOf(code);
        if (endonym === null)
            continue;
        options.push({ code, endonym, englishName: englishNameOf(code) });
    }
    return options.sort((a, b) => a.endonym.localeCompare(b.endonym));
}
/* ------------------------------------------------------------------------ *
 * Reading Discord's own locale
 * ------------------------------------------------------------------------ */
/** Where Discord's desktop client keeps `settings.json` (which carries `locale`). */
export function discordSettingsPathFor(platform = process.platform, env = process.env, home = homedir()) {
    if (platform === "darwin")
        return join(home, "Library", "Application Support", "discord", "settings.json");
    if (platform === "win32") {
        return env.APPDATA ? join(env.APPDATA, "discord", "settings.json") : null;
    }
    return null;
}
/**
 * The locale Discord is set to, as a bare code.
 *
 * Never an error: a missing or unreadable file just means "we could not
 * pre-fill", and the step still works — it simply starts from the system
 * locale instead. A failure to guess is not a failure to install.
 */
export function readDiscordLocale(settingsPath) {
    if (settingsPath === null || !existsSync(settingsPath))
        return null;
    try {
        const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
        if (typeof parsed !== "object" || parsed === null)
            return null;
        const { locale } = parsed;
        return typeof locale === "string" ? normalizeLangCode(locale) : null;
    }
    catch {
        return null;
    }
}
/**
 * The code the language screen opens on: Discord's locale, else the system's,
 * else English.
 *
 * Always returns something, because "we could not work out a default" is not a
 * screen anyone should have to read.
 */
export function defaultLanguage(options = {}) {
    for (const candidate of [options.discordLocale, options.systemLocale]) {
        // `isKnownLanguage`, not merely "parses": a locale string we cannot
        // resolve to a real language must fall through to the next candidate
        // rather than pre-fill the picker with a code that translates nothing.
        if (isKnownLanguage(candidate))
            return normalizeLangCode(candidate);
    }
    return "en";
}
/* ------------------------------------------------------------------------ *
 * Writing the setting into Vencord's settings.json
 * ------------------------------------------------------------------------ */
/**
 * Vencord's data directory, following Vencord's own resolution order
 * (`src/main/utils/constants.ts`): `$VENCORD_USER_DATA_DIR`, else
 * `$DISCORD_USER_DATA_DIR/../VencordData`, else the platform default beside
 * Discord's own user data.
 */
export function vencordSettingsPathFor(platform = process.platform, env = process.env, home = homedir()) {
    if (env.VENCORD_USER_DATA_DIR)
        return join(env.VENCORD_USER_DATA_DIR, "settings", "settings.json");
    if (env.DISCORD_USER_DATA_DIR)
        return join(env.DISCORD_USER_DATA_DIR, "..", "VencordData", "settings", "settings.json");
    if (platform === "darwin") {
        return join(home, "Library", "Application Support", "Vencord", "settings", "settings.json");
    }
    if (platform === "win32") {
        return env.APPDATA ? join(env.APPDATA, "Vencord", "settings", "settings.json") : null;
    }
    return null;
}
/**
 * Write the chosen reading language into Vencord's settings.
 *
 * MERGES. Everything already in the file — other plugins, other settings of
 * ours — is read, updated in place and written back. A user who already ran
 * Vencord keeps their setup; spec §1 makes wiping it the thing that "ends a
 * product's reputation early".
 *
 * A settings file that exists but is corrupt is an ERROR, not something to
 * overwrite: replacing it would destroy whatever was in there, and the honest
 * outcome is to tell the user their Vencord settings are unreadable.
 */
export function setTargetLanguage(settingsPath, rawCode) {
    const code = normalizeLangCode(rawCode);
    if (code === null || !isKnownLanguage(code)) {
        return err("IO_ERROR", `"${rawCode}" is not a language code, so it was not saved.`);
    }
    if (settingsPath === null) {
        return err("IO_ERROR", "Could not work out where Vencord keeps its settings on this platform, so the reading language was not saved.");
    }
    const created = !existsSync(settingsPath);
    let root = {};
    if (!created) {
        let text;
        try {
            text = readFileSync(settingsPath, "utf8");
        }
        catch (cause) {
            return fsError(cause, settingsPath, "read Vencord's settings");
        }
        try {
            const parsed = JSON.parse(text);
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
                throw new Error("not an object");
            root = parsed;
        }
        catch (cause) {
            return err("IO_ERROR", `Vencord's settings file at ${settingsPath} could not be read as JSON, so the reading language was not saved. Subline will not overwrite it.`, { path: settingsPath, cause });
        }
    }
    const plugins = (typeof root.plugins === "object" && root.plugins !== null && !Array.isArray(root.plugins))
        ? root.plugins
        : {};
    const existing = (typeof plugins[PLUGIN_SETTINGS_KEY] === "object" && plugins[PLUGIN_SETTINGS_KEY] !== null)
        ? plugins[PLUGIN_SETTINGS_KEY]
        : {};
    const previousRaw = existing[TARGET_LANG_KEY];
    const previous = typeof previousRaw === "string" ? previousRaw : null;
    plugins[PLUGIN_SETTINGS_KEY] = { ...existing, enabled: true, [TARGET_LANG_KEY]: code };
    root.plugins = plugins;
    try {
        mkdirSync(dirname(settingsPath), { recursive: true });
        // Write-then-rename: a crash mid-write must not leave a user with a
        // truncated settings.json, which Vencord would then refuse to load.
        const temp = `${settingsPath}.subline-tmp`;
        writeFileSync(temp, `${JSON.stringify(root, null, 4)}\n`, "utf8");
        renameSync(temp, settingsPath);
    }
    catch (cause) {
        return fsError(cause, settingsPath, "save the reading language into Vencord's settings");
    }
    return ok({ path: settingsPath, code, previous, created });
}
/** What the setting currently says, for the settings screen and the log. */
export function readTargetLanguage(settingsPath) {
    if (settingsPath === null || !existsSync(settingsPath))
        return null;
    try {
        const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
        const plugins = parsed?.plugins;
        const plugin = plugins?.[PLUGIN_SETTINGS_KEY];
        const value = plugin?.[TARGET_LANG_KEY];
        return typeof value === "string" ? value : null;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=language.js.map