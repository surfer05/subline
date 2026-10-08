/**
 * Tell the user, once, that their installed Subline APP is too old.
 *
 * The update feed keeps the mod bundle current but never the installed app,
 * and the app's background helper is what repairs Discord after a Discord
 * update. An old app therefore keeps an old helper forever. This is the
 * worst-case fallback: one notice in Discord, with a button to the download
 * page. Running the new app keeps the user's code (it lives in Vencord's
 * settings, which the installer merges into and never replaces).
 *
 * RULES.
 *  - Never blocks translation. This only ever shows a notice.
 *  - Once per mod version. Recorded BEFORE it is shown, so a Discord restart,
 *    an ignored notice or a crash never shows it twice. A later mod version
 *    shows it again only if the app is still old (or still cannot repair).
 *  - Only on a Subline-managed install (signals.managed). A Vencord-only or
 *    hand-built install has no Subline app to update.
 *
 * PURE AND INJECTED, like updateNotice.ts. index.tsx supplies the real
 * DataStore, native reader and notice.
 */

import type { AppSignals } from "./appSignals";

/**
 * The oldest app whose helper this mod is happy with. THE one place this is
 * set. Raise it when a release fixes something only the app or helper can fix.
 */
export const MIN_APP_VERSION = "0.2.3";

/** Where the Download button goes. */
export const APP_DOWNLOAD_URL = "https://subline.page/#downloads";

/** DataStore key: the mod version the notice was last shown for. */
export const APP_NOTICE_SHOWN_KEY = "VcTranslate_appNoticeShownFor";

export const APP_NOTICE_COPY = {
    text: "Download the new Subline once to keep it working after Discord updates.",
    button: "Download",
    later: "Later"
} as const;

/**
 * Compare dotted numeric versions. Missing parts are 0 ("0.2" = "0.2.0").
 * A part that is not a number counts as 0, so garbage reads as old, never new.
 */
export function compareVersions(a: string, b: string): number {
    const pa = a.split(".").map(n => Number.parseInt(n, 10));
    const pb = b.split(".").map(n => Number.parseInt(n, 10));
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = Number.isFinite(pa[i]) ? pa[i]! : 0;
        const y = Number.isFinite(pb[i]) ? pb[i]! : 0;
        if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
}

/** Is this app too old? Null (no file, corrupt file) is old. */
export function appTooOld(appVersion: string | null, min: string = MIN_APP_VERSION): boolean {
    return appVersion === null || compareVersions(appVersion, min) < 0;
}

/** Should the notice show now? */
export function shouldShowAppNotice(
    signals: AppSignals,
    modVersion: string,
    lastShownFor: unknown,
    min: string = MIN_APP_VERSION
): boolean {
    if (!signals.managed) return false;
    if (lastShownFor === modVersion) return false;
    return appTooOld(signals.appVersion, min) || signals.cannotRepair;
}

export interface AppNoticeDeps {
    /** The running mod's version (PLUGIN_VERSION). */
    modVersion: string;
    /** Reads the app's signals. May reject; a rejection shows nothing. */
    readSignals: () => Promise<AppSignals>;
    storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; };
    /** Show the notice. */
    show: () => void;
    /** Diagnostics: why nothing was shown, or that it was. Never message text. */
    log?: (event: string, detail: Record<string, unknown>) => void;
}

/**
 * Check once and show the notice if it is due. Returns whether it showed.
 * Never throws.
 */
export async function checkAppNotice(deps: AppNoticeDeps): Promise<boolean> {
    try {
        const signals = await deps.readSignals();
        let lastShownFor: unknown;
        try {
            lastShownFor = await deps.storage.get(APP_NOTICE_SHOWN_KEY);
        } catch {
            lastShownFor = undefined;
        }
        if (!shouldShowAppNotice(signals, deps.modVersion, lastShownFor)) return false;
        // Recorded first: if this write fails, the notice is NOT shown, so a
        // broken store can never turn "once" into "every launch".
        await deps.storage.set(APP_NOTICE_SHOWN_KEY, deps.modVersion);
        deps.log?.("app-notice.shown", {
            appVersion: signals.appVersion,
            cannotRepair: signals.cannotRepair,
            min: MIN_APP_VERSION
        });
        deps.show();
        return true;
    } catch (cause) {
        deps.log?.("app-notice.check-failed", { cause: String(cause) });
        return false;
    }
}
