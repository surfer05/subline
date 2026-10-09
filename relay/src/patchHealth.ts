/**
 * PATCH HEALTH: the field's report of Subline's Vencord patches that stopped
 * applying, and the owner's same-day email when several installs agree.
 *
 * WHY. Discord changes its web code whenever it likes. When a `find` or a
 * `match` of a patch Subline depends on stops matching, Vencord only logs a
 * warning in the user's DevTools and the feature vanishes for everyone. The
 * daily CI check (.github/workflows/patch-check.yml) reads Discord's public
 * web bundle; this endpoint is the second source: what the desktop builds that
 * paying users actually run are doing.
 *
 * WHAT ARRIVES (POST /v1/patch-health, a v2 client with its install header):
 *   { v: 1, plugin: "0.2.3", build: "<16 hex>", channel: "stable",
 *     discordBuild: 123456, failed: [{ plugin, find, state }] }
 * No user id beyond the install header (hashed before it is stored), no
 * message text, no code. `find` is the patch's own search string, which is
 * Discord's public code, never user data. Validation is strict: anything else
 * in the body, or any field out of shape, is a 400.
 *
 * WHERE IT IS KEPT. One Durable Object per UTC day (`ph:<YYYY-MM-DD>`), so
 * counting distinct installs is exact and atomic, and the object deletes itself
 * eight days later (alarm). A report costs ONE storage put; a duplicate or a
 * refused report costs none.
 *
 * LIMITS (worst case: a script posting random install ids):
 *   - an install is counted once per Discord build per day, and for at most
 *     MAX_BUILDS_PER_INSTALL builds a day;
 *   - an address (hashed /64 or IPv4) may add MAX_REPORTS_PER_ADDRESS reports
 *     a day;
 *   - at most MAX_PATCHES_PER_DAY distinct patches are tracked a day;
 *   - at most MAX_EMAILS_PER_DAY emails go out a day, ONE per patch, plus
 *     RESERVED_EMAILS kept for a patch that 2 x the threshold of distinct
 *     ADDRESSES report, so junk cannot use up the day's emails;
 *   - an address may open MAX_NEW_PATCHES_PER_ADDRESS new patch rows a day,
 *     and a full table evicts a row only one address reported (never one
 *     several addresses agree on) to make room;
 *   - `plugin` must be one of PATCH_PLUGINS, the plugins the client checks.
 * The email text is built only from validated printable ASCII, so a report can
 * never add a header line.
 *
 * THE ALERT. When at least PATCH_ALERT_MIN_INSTALLS (default 3) distinct
 * installs FROM AS MANY DISTINCT ADDRESSES report the same patch (plugin +
 * find) on one day, one email goes to
 * PATCH_ALERT_TO through the `ALERT_EMAIL` send_email binding. If the send
 * fails, the patch is marked unsent again so the next report retries it.
 */
import { ipBucket, type Env } from "./codes";
import { installHash } from "./checkout";
import { installOf, isApiV2 } from "./entitle";
import { readCapped } from "./body";
import { emailMessage } from "./email";

export const PATCH_HEALTH_MAX_BODY = 8_192;
export const MAX_FAILED_PER_REPORT = 20;
export const MAX_FIND_CHARS = 160;
export const MAX_BUILDS_PER_INSTALL = 3;
export const MAX_REPORTS_PER_ADDRESS = 20;
export const MAX_PATCHES_PER_DAY = 200;
export const MAX_EMAILS_PER_DAY = 10;
/** Emails above MAX_EMAILS_PER_DAY, only for a patch with 2 x the threshold of distinct addresses. */
export const RESERVED_EMAILS = 2;
/** New patch rows one address may open a day (two full reports). */
export const MAX_NEW_PATCHES_PER_ADDRESS = 2 * MAX_FAILED_PER_REPORT;
/**
 * The only plugin names a report may carry: the client's HEALTH_PLUGINS
 * (src/userplugins/vcTranslate/patchHealth.ts). Anything else is a 400, so the
 * alert's Subject is never a name a stranger picked.
 */
export const PATCH_PLUGINS: readonly string[] = ["VcTranslate", "MessageAccessoriesAPI", "MessagePopoverAPI", "NoticesAPI", "Settings"];
/** Distinct installs kept per patch. Past this the count stops growing. */
export const MAX_INSTALLS_PER_PATCH = 500;
export const DEFAULT_MIN_INSTALLS = 3;
export const DEFAULT_ALERT_FROM = "alerts@subline.page";
export const DEFAULT_ALERT_TO = "rahul05alok@gmail.com";
/** How long a day's object keeps its data. */
export const KEEP_MS = 8 * 86_400_000;
export const ADMIN_DEFAULT_DAYS = 3;

export const PATCH_STATES = ["nofind", "multi", "nomatch"] as const;
export type PatchState = typeof PATCH_STATES[number];
export const CHANNELS = ["stable", "ptb", "canary", "other"] as const;
export type Channel = typeof CHANNELS[number];

export interface FailedPatch { plugin: string; find: string; state: PatchState }
export interface PatchReport {
    v: 1;
    plugin: string;
    build: string;
    channel: Channel;
    discordBuild: number;
    failed: FailedPatch[];
}

const PLUGIN_NAME_RE = /^[A-Za-z][A-Za-z0-9]{0,39}$/;
const PRINTABLE_RE = /^[\x20-\x7e]+$/;
const VERSION_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const BUILD_ID_RE = /^[0-9a-f]{16}$/;

function exactKeys(o: Record<string, unknown>, keys: string[]): boolean {
    const have = Object.keys(o);
    return have.length === keys.length && keys.every(k => Object.hasOwn(o, k));
}

/** The report, or null when anything is out of shape. Duplicate rows collapse. */
export function validateReport(v: unknown): PatchReport | null {
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const o = v as Record<string, unknown>;
    if (!exactKeys(o, ["v", "plugin", "build", "channel", "discordBuild", "failed"])) return null;
    if (o.v !== 1) return null;
    if (typeof o.plugin !== "string" || !VERSION_RE.test(o.plugin)) return null;
    if (typeof o.build !== "string" || !BUILD_ID_RE.test(o.build)) return null;
    if (typeof o.channel !== "string" || !(CHANNELS as readonly string[]).includes(o.channel)) return null;
    if (typeof o.discordBuild !== "number" || !Number.isInteger(o.discordBuild) || o.discordBuild < 0 || o.discordBuild > 99_999_999) return null;
    if (!Array.isArray(o.failed) || o.failed.length === 0 || o.failed.length > MAX_FAILED_PER_REPORT) return null;
    const failed: FailedPatch[] = [];
    const seen = new Set<string>();
    for (const f of o.failed) {
        if (!f || typeof f !== "object" || Array.isArray(f)) return null;
        const r = f as Record<string, unknown>;
        if (!exactKeys(r, ["plugin", "find", "state"])) return null;
        if (typeof r.plugin !== "string" || !PLUGIN_NAME_RE.test(r.plugin) || !PATCH_PLUGINS.includes(r.plugin)) return null;
        if (typeof r.find !== "string" || r.find.length > MAX_FIND_CHARS || !PRINTABLE_RE.test(r.find)) return null;
        if (typeof r.state !== "string" || !(PATCH_STATES as readonly string[]).includes(r.state)) return null;
        const key = `${r.plugin}|${r.find}|${r.state}`;
        if (seen.has(key)) continue;
        seen.add(key);
        failed.push({ plugin: r.plugin, find: r.find, state: r.state as PatchState });
    }
    return { v: 1, plugin: o.plugin, build: o.build, channel: o.channel as Channel, discordBuild: o.discordBuild, failed };
}

/* ======================================================== the day's state == */

export interface PatchRow {
    plugin: string;
    find: string;
    /** Distinct install fingerprints (16 hex), at most MAX_INSTALLS_PER_PATCH. */
    installs: string[];
    /** Distinct address fingerprints, at most MAX_INSTALLS_PER_PATCH. A row
     *  stored before this field was kept has none. */
    addrs?: string[];
    /** "<channel>:<build>" → state → reports. */
    builds: Record<string, Partial<Record<PatchState, number>>>;
    emailed: boolean;
}

export interface DayState {
    reports: number;
    emails: number;
    installs: Map<string, string[]>;
    addresses: Map<string, number>;
    /** New patch rows each address opened today. */
    newRows: Map<string, number>;
    patches: Map<string, PatchRow>;
}

export function emptyDay(): DayState {
    return { reports: 0, emails: 0, installs: new Map(), addresses: new Map(), newRows: new Map(), patches: new Map() };
}

export interface ReportInput {
    inst: string;
    addr: string;
    discordKey: string;
    failed: FailedPatch[];
    minInstalls: number;
}

export interface Alert {
    id: string;
    plugin: string;
    find: string;
    installs: number;
    builds: PatchRow["builds"];
}

export type ApplyResult =
    | { result: "accepted"; writes: Record<string, unknown>; deletes: string[]; alerts: Alert[] }
    | { result: "duplicate" | "install_limited" | "address_limited"; writes: null; deletes?: undefined; alerts: [] };

export function patchId(plugin: string, find: string): string {
    return `${plugin}|${find}`;
}

/**
 * Pure: count one report into the day. Synchronous, so inside the Durable
 * Object the check and the update cannot interleave with another request.
 * `writes` is every storage key this report changed (one put).
 */
export function applyReport(day: DayState, input: ReportInput): ApplyResult {
    const builds = day.installs.get(input.inst) ?? [];
    if (builds.includes(input.discordKey)) return { result: "duplicate", writes: null, alerts: [] };
    if (builds.length >= MAX_BUILDS_PER_INSTALL) return { result: "install_limited", writes: null, alerts: [] };
    const fromAddr = day.addresses.get(input.addr) ?? 0;
    if (fromAddr >= MAX_REPORTS_PER_ADDRESS) return { result: "address_limited", writes: null, alerts: [] };

    const writes: Record<string, unknown> = {};
    const nextBuilds = [...builds, input.discordKey];
    day.installs.set(input.inst, nextBuilds);
    writes[`i:${input.inst}`] = nextBuilds;
    day.addresses.set(input.addr, fromAddr + 1);
    writes[`a:${input.addr}`] = fromAddr + 1;
    day.reports += 1;
    writes.n = day.reports;

    const alerts: Alert[] = [];
    const deletes: string[] = [];
    for (const f of input.failed) {
        const id = patchId(f.plugin, f.find);
        let row = day.patches.get(id);
        if (!row) {
            // One address cannot fill the table: it opens a bounded number of rows.
            const opened = day.newRows.get(input.addr) ?? 0;
            if (opened >= MAX_NEW_PATCHES_PER_ADDRESS) continue;
            if (day.patches.size >= MAX_PATCHES_PER_DAY) {
                // Full: make room by dropping a row only ONE address reported and
                // never emailed. A patch several addresses agree on is kept.
                const victim = [...day.patches.entries()].find(([, r]) => !r.emailed && (r.addrs?.length ?? 0) <= 1);
                if (!victim) continue;
                day.patches.delete(victim[0]);
                delete writes[`p:${victim[0]}`];
                deletes.push(`p:${victim[0]}`);
            }
            day.newRows.set(input.addr, opened + 1);
            writes[`r:${input.addr}`] = opened + 1;
            row = { plugin: f.plugin, find: f.find, installs: [], addrs: [], builds: {}, emailed: false };
            day.patches.set(id, row);
            const at = deletes.indexOf(`p:${id}`);
            if (at >= 0) deletes.splice(at, 1);
        }
        const addrs = row.addrs ?? (row.addrs = []);
        if (!row.installs.includes(input.inst) && row.installs.length < MAX_INSTALLS_PER_PATCH) row.installs.push(input.inst);
        if (!addrs.includes(input.addr) && addrs.length < MAX_INSTALLS_PER_PATCH) addrs.push(input.addr);
        const perBuild = row.builds[input.discordKey] ?? (row.builds[input.discordKey] = {});
        perBuild[f.state] = (perBuild[f.state] ?? 0) + 1;
        // Distinct installs AND distinct addresses: one address minting install
        // ids never sends an email. Past the day's cap, a reserved slot is kept
        // for a patch that twice the threshold of addresses agree on.
        const agreed = row.installs.length >= input.minInstalls && addrs.length >= input.minInstalls;
        const slot = day.emails < MAX_EMAILS_PER_DAY
            || (day.emails < MAX_EMAILS_PER_DAY + RESERVED_EMAILS && addrs.length >= 2 * input.minInstalls);
        if (!row.emailed && agreed && slot) {
            row.emailed = true;
            day.emails += 1;
            writes.e = day.emails;
            alerts.push({ id, plugin: row.plugin, find: row.find, installs: row.installs.length, builds: structuredClone(row.builds) });
        }
        writes[`p:${id}`] = row;
    }
    return { result: "accepted", writes, deletes, alerts };
}

/** Pure: an alert whose email did not go out may be sent by a later report. */
export function applyUnalert(day: DayState, id: string): Record<string, unknown> | null {
    const row = day.patches.get(id);
    if (!row || !row.emailed) return null;
    row.emailed = false;
    day.emails = Math.max(0, day.emails - 1);
    return { [`p:${id}`]: row, e: day.emails };
}

export interface DayView {
    day: string;
    reports: number;
    emails: number;
    patches: Array<{ plugin: string; find: string; installs: number; emailed: boolean; builds: PatchRow["builds"] }>;
}

export function viewOf(dayName: string, day: DayState): DayView {
    const patches = [...day.patches.values()]
        .map(r => ({ plugin: r.plugin, find: r.find, installs: r.installs.length, emailed: r.emailed, builds: r.builds }))
        .sort((a, b) => b.installs - a.installs || a.plugin.localeCompare(b.plugin) || a.find.localeCompare(b.find));
    return { day: dayName, reports: day.reports, emails: day.emails, patches };
}

/* ======================================================== Durable Object == */

/** One object per UTC day, named `ph:<YYYY-MM-DD>`. */
export class PatchHealth {
    private day: DayState = emptyDay();
    private ready: Promise<void>;

    constructor(private ctx: DurableObjectState) {
        this.ready = ctx.blockConcurrencyWhile(async () => {
            const all = await ctx.storage.list();
            for (const [k, v] of all) {
                if (k === "n") this.day.reports = Number(v) || 0;
                else if (k === "e") this.day.emails = Number(v) || 0;
                else if (k.startsWith("i:") && Array.isArray(v)) this.day.installs.set(k.slice(2), v as string[]);
                else if (k.startsWith("a:")) this.day.addresses.set(k.slice(2), Number(v) || 0);
                else if (k.startsWith("r:")) this.day.newRows.set(k.slice(2), Number(v) || 0);
                else if (k.startsWith("p:") && v && typeof v === "object") this.day.patches.set(k.slice(2), v as PatchRow);
            }
        });
    }

    async fetch(req: Request): Promise<Response> {
        await this.ready;
        const path = new URL(req.url).pathname;
        if (path === "/report") {
            const body = await req.json().catch(() => null) as ReportInput | null;
            if (!body || typeof body.inst !== "string" || typeof body.addr !== "string" || typeof body.discordKey !== "string"
                || !Array.isArray(body.failed) || typeof body.minInstalls !== "number") {
                return Response.json({ error: "bad request" }, { status: 400 });
            }
            const out = applyReport(this.day, body);
            if (out.writes) {
                await this.ctx.storage.put(out.writes);
                if (out.deletes && out.deletes.length > 0) await this.ctx.storage.delete(out.deletes);
                await this.armCleanup();
            }
            return Response.json({ result: out.result, alerts: out.alerts });
        }
        if (path === "/unalert") {
            const body = await req.json().catch(() => null) as { id?: unknown } | null;
            const writes = typeof body?.id === "string" ? applyUnalert(this.day, body.id) : null;
            if (writes) await this.ctx.storage.put(writes);
            return Response.json({ unalerted: writes !== null });
        }
        if (path === "/view") {
            const name = new URL(req.url).searchParams.get("day") ?? "";
            return Response.json(viewOf(name, this.day));
        }
        return new Response("not found", { status: 404 });
    }

    /** The day's data is useless after a week: drop it. */
    async alarm(): Promise<void> {
        await this.ctx.storage.deleteAll();
        this.day = emptyDay();
    }

    private async armCleanup(): Promise<void> {
        const storage = this.ctx.storage as DurableObjectStorage & { getAlarm?: () => Promise<number | null>; setAlarm?: (t: number) => Promise<void> };
        if (!storage.getAlarm || !storage.setAlarm) return;
        if ((await storage.getAlarm()) === null) await storage.setAlarm(Date.now() + KEEP_MS);
    }
}

/* ============================================================== handlers == */

const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function utcDay(now: number): string {
    return new Date(now).toISOString().slice(0, 10);
}

function cause(e: unknown): string {
    return String((e as any)?.message ?? e).slice(0, 200);
}

function dayStub(env: Env, day: string): DurableObjectStub {
    return env.PATCH_HEALTH!.get(env.PATCH_HEALTH!.idFromName(`ph:${day}`));
}

export function minInstallsFor(env: Env): number {
    const n = Math.floor(Number(env.PATCH_ALERT_MIN_INSTALLS));
    return Number.isFinite(n) && n >= 1 && n <= 1000 ? n : DEFAULT_MIN_INSTALLS;
}

/** The alert email as raw MIME: plain ASCII text, nothing from a report in a header but the validated plugin name. */
export function alertMime(from: string, to: string, alert: Alert, day: string, now: number, messageId: string): string {
    const builds = Object.entries(alert.builds)
        .map(([k, states]) => `  ${k}: ${Object.entries(states).map(([s, n]) => `${s} x${n}`).join(", ")}`)
        .join("\r\n");
    const body = [
        `${alert.installs} installs reported a Subline patch that no longer applies (${day}, UTC).`,
        "",
        `Plugin: ${alert.plugin}`,
        `Find:   ${alert.find}`,
        "",
        "Discord builds (channel:build number) and what failed:",
        builds,
        "",
        "States: nofind = the find string is in no loaded module; multi = it is in more than one;",
        "nomatch = the module was found but a replacement no longer matches.",
        "",
        "Next: run `pnpm check:patches` and fix the patch. Recent reports: GET /admin/patch-health.",
        "This is the only email for this patch today."
    ].join("\r\n");
    return [
        `From: Subline alerts <${from}>`,
        `To: ${to}`,
        `Subject: Subline patch failing: ${alert.plugin} (${alert.installs} installs)`,
        `Message-ID: <${messageId}@${from.split("@")[1] ?? "subline.page"}>`,
        `Date: ${new Date(now).toUTCString()}`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=us-ascii",
        "Content-Transfer-Encoding: 7bit",
        "",
        body,
        ""
    ].join("\r\n");
}

/** Send one alert. False when it did not go out (no binding, or the send threw). */
export async function sendAlert(env: Env, alert: Alert, day: string, now: number): Promise<boolean> {
    if (!env.ALERT_EMAIL) {
        console.warn("patch health: no ALERT_EMAIL binding, alert not sent", { plugin: alert.plugin, installs: alert.installs });
        return false;
    }
    const from = env.PATCH_ALERT_FROM || DEFAULT_ALERT_FROM;
    const to = env.PATCH_ALERT_TO || DEFAULT_ALERT_TO;
    try {
        await env.ALERT_EMAIL.send(emailMessage(from, to, alertMime(from, to, alert, day, now, crypto.randomUUID())));
        console.warn("patch health: alert emailed", { plugin: alert.plugin, find: alert.find, installs: alert.installs });
        return true;
    } catch (e) {
        console.warn("patch health: alert email failed", { plugin: alert.plugin, error: cause(e) });
        return false;
    }
}

/** POST /v1/patch-health. Never throws; the client ignores the answer anyway. */
export async function handlePatchHealth(req: Request, env: Env, now: number): Promise<Response> {
    if (req.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
    if (!env.PATCH_HEALTH) return json({ ok: false, error: "unavailable" }, 503);
    const install = isApiV2(req) ? installOf(req) : null;
    if (!install) return json({ ok: false, error: "bad request" }, 400);
    const buf = await readCapped(req, PATCH_HEALTH_MAX_BODY);
    if (buf === null) return json({ ok: false, error: "payload too large" }, 413);
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder().decode(buf)); } catch { return json({ ok: false, error: "bad request" }, 400); }
    const report = validateReport(parsed);
    if (!report) return json({ ok: false, error: "bad request" }, 400);

    const day = utcDay(now);
    const ip = req.headers.get("cf-connecting-ip") || "none";
    const input: ReportInput = {
        inst: await installHash(install),
        addr: await installHash(`addr:${ipBucket(ip)}`),
        discordKey: `${report.channel}:${report.discordBuild}`,
        failed: report.failed,
        minInstalls: minInstallsFor(env)
    };
    let out: { result: ApplyResult["result"]; alerts: Alert[] };
    try {
        const res = await dayStub(env, day).fetch("https://patch-health.internal/report", { method: "POST", body: JSON.stringify(input) });
        out = await res.json() as typeof out;
    } catch (e) {
        console.warn("patch health: store unreachable", { error: cause(e) });
        return json({ ok: false, error: "temporarily unavailable" }, 503);
    }
    for (const alert of out.alerts ?? []) {
        if (await sendAlert(env, alert, day, now)) continue;
        try {
            await dayStub(env, day).fetch("https://patch-health.internal/unalert", { method: "POST", body: JSON.stringify({ id: alert.id }) });
        } catch (e) {
            console.warn("patch health: unalert failed", { error: cause(e) });
        }
    }
    if (out.result === "accepted" || out.result === "duplicate") return json({ ok: true });
    return json({ ok: false, error: "rate_limited" }, 429);
}

/** GET /admin/patch-health?days=N (1..8, default 3), newest first. Caller checks the admin token. */
export async function adminPatchHealth(env: Env, url: URL, now: number): Promise<Response> {
    if (!env.PATCH_HEALTH) return json({ ok: false, error: "unavailable" }, 503);
    const raw = Math.floor(Number(url.searchParams.get("days") ?? ADMIN_DEFAULT_DAYS));
    const days = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 8) : ADMIN_DEFAULT_DAYS;
    const out: DayView[] = [];
    try {
        for (let i = 0; i < days; i++) {
            const day = utcDay(now - i * 86_400_000);
            const res = await dayStub(env, day).fetch(`https://patch-health.internal/view?day=${day}`);
            out.push(await res.json() as DayView);
        }
    } catch (e) {
        console.warn("patch health: admin view failed", { error: cause(e) });
        return json({ ok: false, error: "temporarily unavailable" }, 503);
    }
    return json({ ok: true, minInstalls: minInstallsFor(env), days: out });
}
