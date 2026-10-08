/**
 * The reading language chosen on a run that stopped before activation
 * (field test 2026-10-08, I6).
 *
 * The language is written into Vencord's settings only once the install is
 * activated: written earlier, an abandoned run would look like earlier Subline
 * use (language.ts readPriorUse) and let the next run past the paid screen.
 * But a restart mid-checkout then started the installer again at Welcome. So
 * the choice is kept here, in Subline's own folder, which readPriorUse never
 * reads, and cleared once the language is saved for real.
 *
 * Expires after 14 days: someone who comes back a month later is starting
 * over, and Welcome is the right first screen for them.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isKnownLanguage, normalizeLangCode } from "./language.js";
import type { Result } from "../patcher/result.js";
import { fsError, ok } from "../patcher/result.js";

export const PENDING_SETUP_FILENAME = "pending-setup.json";
export const PENDING_SETUP_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

function pathFor(productDir: string): string {
    return join(productDir, PENDING_SETUP_FILENAME);
}

/** The pending language, or null (none, expired, unreadable, or not a language Subline knows). Never throws. */
export function readPendingLanguage(productDir: string | null, now: number): string | null {
    if (productDir === null) return null;
    try {
        const parsed = JSON.parse(readFileSync(pathFor(productDir), "utf8")) as { language?: unknown; at?: unknown } | null;
        const language = typeof parsed?.language === "string" ? normalizeLangCode(parsed.language) : null;
        const at = typeof parsed?.at === "number" ? parsed.at : NaN;
        if (language === null || !isKnownLanguage(language)) return null;
        if (!Number.isFinite(at) || at > now || now - at > PENDING_SETUP_MAX_AGE_MS) return null;
        return language;
    } catch {
        return null;
    }
}

/** Remember the language chosen on this run. Atomic: a crash leaves the old file or the new one. */
export function writePendingLanguage(productDir: string | null, language: string, now: number): Result<true> {
    if (productDir === null) return ok(true);
    const path = pathFor(productDir);
    const temp = `${path}.tmp`;
    try {
        mkdirSync(productDir, { recursive: true });
        writeFileSync(temp, `${JSON.stringify({ language, at: now })}\n`, "utf8");
        renameSync(temp, path);
        return ok(true);
    } catch (cause) {
        return fsError<true>(cause, path, "remember the reading language");
    }
}

/** Forget it. Never throws: a file that cannot be removed expires on its own. */
export function clearPendingLanguage(productDir: string | null): void {
    if (productDir === null) return;
    try {
        rmSync(pathFor(productDir), { force: true });
    } catch {
        // Expires after PENDING_SETUP_MAX_AGE_MS.
    }
}
