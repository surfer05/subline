/**
 * PATCH HEALTH, the client half: did the Vencord patches Subline depends on
 * actually apply in THIS Discord, and if not, tell the relay once.
 *
 * WHY. Vencord patches Discord's code by text. When Discord ships a build where
 * a patch's `find` or `match` no longer fits, Vencord logs a warning in
 * DevTools and the feature silently disappears. A paying user sees nothing
 * wrong except that Subline stopped working. The daily CI check reads
 * Discord's public web bundle; this reads the desktop build the user is
 * actually running, and the relay emails the owner when several installs
 * agree (relay/src/patchHealth.ts).
 *
 * WHAT COUNTS AS FAILED. Only what this client can know for certain:
 *   - "multi":   a non-`all` patch's find occurs in more than one loaded
 *                module (Vencord patches whichever loads first);
 *   - "nomatch": the find hits exactly one loaded module, but a replacement's
 *                match no longer changes it (exactly Vencord's "had no
 *                effect" warning);
 *   - "nofind":  the find occurs in no loaded module and Vencord still holds
 *                the patch as pending. Discord loads most modules lazily, so
 *                this is only reported for plugins whose module is certainly
 *                loaded once a channel's messages are on screen
 *                (`MISSING_IS_FAILURE_AFTER_MESSAGES`), and only after that
 *                happened. Everything else is the CI check's job.
 *
 * WHAT IS SENT. Plugin version, Subline build id, Discord's release channel
 * and build number, and the failed patches (plugin name, the patch's own
 * find string, state). No user id beyond the install header every relay call
 * carries, no message text, no code.
 *
 * COST. Nothing at startup: the check waits for messages to load (or for
 * FALLBACK_MS), scans loaded modules in slices with a yield between them, and
 * runs at most once per Discord build per UTC day (a DataStore mark). Never
 * throws, never rejects: diagnostics must not become a way for Subline to
 * break.
 */

export type PatchState = "nofind" | "multi" | "nomatch";
export interface FailedPatch { plugin: string; find: string; state: PatchState; }

export interface PatchHealthReport {
    v: 1;
    plugin: string;
    build: string;
    channel: "stable" | "ptb" | "canary" | "other";
    discordBuild: number;
    failed: FailedPatch[];
}

/** The plugins whose patches Subline needs: its own, and the APIs it uses. */
export const HEALTH_PLUGINS = ["VcTranslate", "MessageAccessoriesAPI", "MessagePopoverAPI", "NoticesAPI", "Settings"] as const;

/**
 * Plugins whose patched module is certainly loaded once a channel's messages
 * are on screen: MessageAccessoriesAPI patches the message body itself, which
 * is where every subtitle is drawn. Only for these is "find in no loaded
 * module" a failure rather than "not loaded yet".
 */
export const MISSING_IS_FAILURE_AFTER_MESSAGES: ReadonlySet<string> = new Set(["MessageAccessoriesAPI"]);

export const MAX_FAILED = 20;
export const MAX_FIND_CHARS = 160;
/** After messages load, give Discord this long to finish loading the chat UI. */
export const SETTLE_MS = 30_000;
/** No messages ever loaded (the Friends page, a quiet start): check anyway after this. */
export const FALLBACK_MS = 10 * 60_000;
/** Modules scanned between two yields to the UI. */
export const SCAN_SLICE = 400;
export const HEALTH_STORE_KEY = "VcTranslate_patchHealth";

/* ================================================================ scanning == */

interface ReplacementLike { match: string | RegExp; replace?: unknown; noWarn?: boolean; }
export interface PatchLike {
    find: string | RegExp;
    all?: boolean;
    noWarn?: boolean;
    predicate?: () => boolean;
    replacement: ReplacementLike | ReplacementLike[];
}
export interface PluginPatches { plugin: string; patches: PatchLike[]; }

export interface ScanInput {
    plugins: PluginPatches[];
    /** Vencord's pending patch list (WebpackPatcher.patches): a patch Vencord has not applied yet. */
    pending: ReadonlySet<unknown>;
    /** Source of every loaded webpack module factory. */
    moduleSources: () => Iterable<string>;
    /** Whether a channel's messages have been on screen this session. */
    messagesSeen: boolean;
    yieldEvery?: number;
    yieldFn?: () => Promise<void>;
}

function hits(find: string | RegExp, src: string): boolean {
    if (typeof find === "string") return src.includes(find);
    if (find.global || find.sticky) find.lastIndex = 0;
    return find.test(src);
}

/** A name for a find: printable ASCII only, bounded, so it validates on the relay. */
export function findName(find: string | RegExp): string {
    const raw = typeof find === "string" ? find : String(find);
    // eslint-disable-next-line no-control-regex
    const clean = raw.replace(/[^\x20-\x7e]/g, "?");
    return clean.length > MAX_FIND_CHARS ? clean.slice(0, MAX_FIND_CHARS - 3) + "..." : (clean || "?");
}

/** True when every non-noWarn replacement changes `src` in turn, as Vencord applies them. */
function replacementsApply(patch: PatchLike, src: string): boolean {
    const list = Array.isArray(patch.replacement) ? patch.replacement : [patch.replacement];
    let code = src;
    for (const r of list) {
        if (!r || r.match == null) continue;
        if (typeof r.match !== "string" && (r.match.global || r.match.sticky)) r.match.lastIndex = 0;
        let next: string;
        try {
            // A function replace could have side effects; only test the match.
            if (typeof r.replace === "string") next = code.replace(r.match, r.replace);
            else next = hits(r.match, code) ? code + "\u0000" : code;
        } catch {
            next = code;
        }
        if (next === code) {
            if (patch.noWarn || r.noWarn) continue;
            return false;
        }
        if (typeof r.replace === "string") code = next;
    }
    return true;
}

/** Every Subline patch that certainly did not apply. Never throws. */
export async function findFailedPatches(input: ScanInput): Promise<FailedPatch[]> {
    const targets: Array<{ plugin: string; patch: PatchLike; count: number; source: string | null; }> = [];
    for (const { plugin, patches } of input.plugins) {
        for (const patch of patches ?? []) {
            try {
                if (!patch || patch.find == null) continue;
                if (patch.predicate && !patch.predicate()) continue;
                targets.push({ plugin, patch, count: 0, source: null });
            } catch { /* a predicate that throws: Vencord would not apply it either */ }
        }
    }
    if (targets.length === 0) return [];

    const every = input.yieldEvery ?? SCAN_SLICE;
    const pause = input.yieldFn ?? (() => new Promise<void>(r => setTimeout(r, 0)));
    let n = 0;
    for (const src of input.moduleSources()) {
        if (typeof src === "string") {
            for (const t of targets) {
                try {
                    if (hits(t.patch.find, src)) {
                        t.count += 1;
                        if (t.source === null) t.source = src;
                    }
                } catch { /* a find that throws on test: treat as no hit */ }
            }
        }
        if (++n % every === 0) await pause();
    }

    const failed: FailedPatch[] = [];
    for (const t of targets) {
        let state: PatchState | null = null;
        if (t.count === 0) {
            if (input.pending.has(t.patch) && input.messagesSeen && MISSING_IS_FAILURE_AFTER_MESSAGES.has(t.plugin)) state = "nofind";
        } else if (t.count > 1 && !t.patch.all) {
            state = "multi";
        } else if (!t.patch.all && t.source !== null && !replacementsApply(t.patch, t.source)) {
            state = "nomatch";
        }
        if (state) failed.push({ plugin: t.plugin, find: findName(t.patch.find), state });
        if (failed.length >= MAX_FAILED) break;
    }
    return failed;
}

/* ============================================================== reporting == */

export function releaseChannel(raw: unknown): PatchHealthReport["channel"] {
    return raw === "stable" || raw === "ptb" || raw === "canary" ? raw : "other";
}

export interface CheckDeps {
    now: () => number;
    pluginVersion: string;
    buildId: string;
    channel: () => unknown;
    buildNumber: () => number;
    load: () => Promise<unknown>;
    save: (value: { key: string; }) => Promise<void>;
    scan: (messagesSeen: boolean) => Promise<FailedPatch[]>;
    /** Resolves true when the relay took the report. */
    send: (report: PatchHealthReport) => Promise<boolean>;
    log?: (message: string, detail?: unknown) => void;
}

export type CheckOutcome = "skipped" | "clean" | "sent" | "unsent" | "error";

/**
 * One check: skip when this Discord build was already checked today, else
 * scan, and send only when something failed. The mark is written after a
 * clean scan or a send the relay took; an unsent report is tried again on the
 * next start. Never throws.
 */
export async function runPatchHealthCheck(deps: CheckDeps, messagesSeen: boolean): Promise<CheckOutcome> {
    try {
        const channel = releaseChannel(deps.channel());
        const n = Number(deps.buildNumber());
        const discordBuild = Number.isInteger(n) && n > 0 && n <= 99_999_999 ? n : 0;
        const day = new Date(deps.now()).toISOString().slice(0, 10);
        const key = `${channel}:${discordBuild}:${day}`;
        const last = await deps.load().catch(() => undefined) as { key?: unknown; } | undefined;
        if (last && last.key === key) return "skipped";

        const failed = await deps.scan(messagesSeen);
        if (failed.length === 0) {
            await deps.save({ key }).catch(() => { });
            return "clean";
        }
        const report: PatchHealthReport = {
            v: 1, plugin: deps.pluginVersion, build: deps.buildId, channel, discordBuild,
            failed: failed.slice(0, MAX_FAILED)
        };
        deps.log?.(`${failed.length} Subline patch(es) did not apply on Discord ${channel} ${discordBuild}`, failed);
        const ok = await deps.send(report).catch(() => false);
        if (!ok) return "unsent";
        await deps.save({ key }).catch(() => { });
        return "sent";
    } catch (err) {
        deps.log?.("patch health check failed", err);
        return "error";
    }
}

/* ============================================================== schedule == */

export interface WatchDeps {
    run: (messagesSeen: boolean) => Promise<unknown>;
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
    settleMs?: number;
    fallbackMs?: number;
}

export interface PatchHealthWatch {
    start(): void;
    /** A channel's messages are on screen. The first call arms the check. */
    noteMessagesLoaded(): void;
    stop(): void;
}

/**
 * Runs the check at most once per session: SETTLE_MS after messages first
 * load, or at FALLBACK_MS if they never do. Nothing runs at start() itself.
 */
export function createPatchHealthWatch(deps: WatchDeps): PatchHealthWatch {
    let fallback: unknown = null;
    let settle: unknown = null;
    let done = false;
    let running = false;
    const fire = (messagesSeen: boolean) => {
        if (done || !running) return;
        done = true;
        if (fallback !== null) deps.clearTimeout(fallback);
        if (settle !== null) deps.clearTimeout(settle);
        fallback = settle = null;
        try {
            void Promise.resolve(deps.run(messagesSeen)).catch(() => { });
        } catch { /* never let diagnostics reach the caller */ }
    };
    return {
        start() {
            if (running || done) return;
            running = true;
            fallback = deps.setTimeout(() => { fallback = null; fire(false); }, deps.fallbackMs ?? FALLBACK_MS);
        },
        noteMessagesLoaded() {
            if (!running || done || settle !== null) return;
            settle = deps.setTimeout(() => { settle = null; fire(true); }, deps.settleMs ?? SETTLE_MS);
        },
        stop() {
            running = false;
            if (fallback !== null) deps.clearTimeout(fallback);
            if (settle !== null) deps.clearTimeout(settle);
            fallback = settle = null;
        }
    };
}

/* ============================================ reading Vencord's own state == */

/**
 * Scan using the running Vencord (the global `Vencord` object): its plugins'
 * patch objects (canonicalised in place by Vencord), its pending patch list,
 * and the loaded module factories (String(factory) is the ORIGINAL source;
 * Vencord's factory proxy redirects toString). Anything missing reads as
 * nothing to check. Never throws.
 */
export async function scanFromVencord(V: any, messagesSeen: boolean, yieldFn?: () => Promise<void>): Promise<FailedPatch[]> {
    try {
        const plugins: PluginPatches[] = [];
        const all = V?.Plugins?.plugins ?? {};
        for (const name of HEALTH_PLUGINS) {
            const p = all[name];
            if (!p || !Array.isArray(p.patches) || p.patches.length === 0) continue;
            try {
                if (typeof V.Plugins.isPluginEnabled === "function" && !V.Plugins.isPluginEnabled(name)) continue;
            } catch { continue; }
            plugins.push({ plugin: name, patches: p.patches });
        }
        const list = V?.WebpackPatcher?.patches;
        const pending = new Set<unknown>(Array.isArray(list) ? list : []);
        const m = V?.Webpack?.wreq?.m;
        function* moduleSources(): Iterable<string> {
            if (!m) return;
            let ids: string[];
            try { ids = Object.keys(m); } catch { return; }
            for (const id of ids) {
                try {
                    const f = m[id];
                    if (typeof f === "function") yield String(f);
                } catch { /* one unreadable factory: skip it */ }
            }
        }
        return await findFailedPatches({ plugins, pending, moduleSources, messagesSeen, yieldFn });
    } catch {
        return [];
    }
}

/** Discord's build number as Vencord reads it, or 0 when unknown. */
export function buildNumberFromVencord(V: any): number {
    try {
        const n = Number(V?.WebpackPatcher?.getBuildNumber?.());
        return Number.isInteger(n) && n > 0 ? n : 0;
    } catch {
        return 0;
    }
}
