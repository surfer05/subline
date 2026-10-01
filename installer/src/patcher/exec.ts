/**
 * The one way this app runs a console program (tasklist, schtasks, ps,
 * powershell, tar, launchctl, osascript...).
 *
 * WINDOWS HIDES NOTHING BY DEFAULT. Node's execFile defaults to
 * `windowsHide: false`, and when a process with no console (the helper, a
 * GUI Electron exe started by Task Scheduler every 5 minutes) starts a console
 * program, Windows gives that child a NEW, VISIBLE console window. Every
 * helper run flashed tasklist and schtasks windows on the user's screen, and a
 * flashing console can steal focus from a fullscreen game. Every call site
 * goes through here, and tests/exec.test.ts fails if a new one does not.
 *
 * `maxBuffer` is raised because `tasklist` and `ps` on a busy machine can
 * exceed Node's 1 MB default, which fails the call and reads as "no Discord
 * running".
 */

import { execFile } from "node:child_process";

export type Exec = (file: string, args: string[]) => Promise<{ stdout: string }>;

/** What execFile gets: the hidden-window option and a generous buffer. Exported for the tests. */
export const HIDDEN_EXEC_OPTIONS = Object.freeze({ windowsHide: true, maxBuffer: 16 * 1024 * 1024 });

type ExecFileLike = (
    file: string,
    args: readonly string[],
    options: { windowsHide: boolean; maxBuffer: number },
    callback: (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void
) => unknown;

/** An Exec that never shows a console window. `impl` is injectable for the tests. */
export function hiddenExec(impl: ExecFileLike = execFile as unknown as ExecFileLike): Exec {
    return (file, args) => new Promise((resolve, reject) => {
        impl(file, args, { ...HIDDEN_EXEC_OPTIONS }, (error, stdout, stderr) => {
            const text = (value: string | Buffer | undefined): string =>
                value === undefined ? "" : typeof value === "string" ? value : value.toString("utf8");
            if (error !== null && error !== undefined) {
                // What util.promisify(execFile) does: the output rides on the
                // error, so describeCause can quote what the program said.
                reject(Object.assign(error, { stdout: text(stdout), stderr: text(stderr) }));
                return;
            }
            resolve({ stdout: text(stdout) });
        });
    });
}
