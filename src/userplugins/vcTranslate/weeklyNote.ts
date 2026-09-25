import * as DataStore from "@api/DataStore";

import { DAY_MS } from "./freePlan";

/**
 * THE WEEKLY NOTE: "This week: 12 messages in 3 languages."
 *
 * One honest sentence, at most once every seven days, for every install (paid
 * included): how many foreign messages got a translation on screen, and in how
 * many languages. Never shown for an empty week; a zero is not news.
 *
 * WHAT COUNTS. A message is counted the first time a REAL translation for it is
 * accepted into the store (index.tsx's writeResult), whichever tier wrote it.
 * The ≈ line and the ✦ line that later replaces it are one message, not two,
 * and a message whose translation was restored from the persisted cache after
 * a restart is not counted again, because its store entry already held a real
 * translation. The language is the detected SOURCE language of that first
 * translation. No message id and no text is ever kept: only a count and a list
 * of language codes.
 *
 * Persisted in DataStore (not settings: it changes on every counted message,
 * and a settings write rewrites the user's whole settings file).
 */

export const WEEKLY_KEY = "VcTranslate_weeklyStats";
export const WEEK_MS = 7 * DAY_MS;

export interface WeeklyStats {
    /** When the current counting week began (epoch ms). */
    weekStart: number;
    /** Foreign messages with a translation shown this week. */
    count: number;
    /** Distinct detected source languages this week. */
    langs: string[];
    /** When the note was last shown (epoch ms), 0 for never. */
    lastNoteAt: number;
}

let stats: WeeklyStats | null = null;

function fresh(now: number): WeeklyStats {
    return { weekStart: now, count: 0, langs: [], lastNoteAt: 0 };
}

/** Re-validated rather than trusted, like every other persisted value here. */
function parse(raw: unknown, now: number): WeeklyStats {
    if (!raw || typeof raw !== "object") return fresh(now);
    const r = raw as Partial<WeeklyStats>;
    const num = (v: unknown, d: number) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d;
    return {
        weekStart: num(r.weekStart, now),
        count: Math.floor(num(r.count, 0)),
        langs: Array.isArray(r.langs) ? r.langs.filter((l): l is string => typeof l === "string").slice(0, 200) : [],
        lastNoteAt: num(r.lastNoteAt, 0)
    };
}

function persist(): void {
    if (stats === null) return;
    // Not awaited: a flush must never wait on IndexedDB, and a lost write
    // costs one message of this week's count.
    void DataStore.set(WEEKLY_KEY, { ...stats, langs: [...stats.langs] }).catch(() => { });
}

export async function loadWeeklyStats(now: number = Date.now()): Promise<void> {
    let raw: unknown;
    try {
        raw = await DataStore.get<unknown>(WEEKLY_KEY);
    } catch {
        raw = undefined;
    }
    stats = parse(raw, now);
    if (raw === undefined) persist();
}

/**
 * If the week is over: the note to show (or null for an empty week), and a
 * fresh week begins. Returns null while the week is still running.
 */
export function closeWeekIfDue(now: number = Date.now()): string | null {
    if (stats === null) return null;
    if (now - stats.weekStart < WEEK_MS) return null;
    const { count, langs, lastNoteAt } = stats;
    const due = count > 0 && (lastNoteAt === 0 || now - lastNoteAt >= WEEK_MS);
    stats = { weekStart: now, count: 0, langs: [], lastNoteAt: due ? now : lastNoteAt };
    persist();
    return due ? weeklyNoteText(count, langs.length) : null;
}

/** Count one message whose first real translation was just shown. */
export function countShown(lang: string | undefined): void {
    if (stats === null) return;
    stats.count++;
    const l = typeof lang === "string" ? lang.trim().toLowerCase() : "";
    if (l !== "" && !stats.langs.includes(l)) stats.langs.push(l);
    persist();
}

export function weeklyNoteText(n: number, m: number): string {
    return `This week: ${n} ${n === 1 ? "message" : "messages"} in ${m} ${m === 1 ? "language" : "languages"}.`;
}

/** Test-only. */
export function __weeklyStats(): WeeklyStats | null {
    return stats === null ? null : { ...stats, langs: [...stats.langs] };
}

export function __resetWeeklyStats(): void {
    stats = null;
}
