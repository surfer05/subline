/**
 * Which folder a running Windows process was started from (audit 2026-10-06
 * #23, #28). tasklist gives image names only; Get-CimInstance gives the path.
 * Used to tell the Discord running an OLD app-1.0.x folder from the new one,
 * and Discord's own Update.exe from another app's.
 */

import type { Exec } from "../patcher/exec.js";

/**
 * The executable path of every running process with this image name, one per
 * line, from Get-CimInstance (audit 2026-10-06 #28). "?" is a process whose
 * path Windows would not give (another session, elevated): it stays in the
 * list as null, so it is never assumed to be elsewhere.
 */
export function parseExecutablePaths(stdout: string): Array<string | null> {
    return stdout.replace(/\r/g, "").split("\n")
        .map(line => line.trim())
        .filter(line => line !== "")
        .map(line => (line === "?" ? null : line));
}

/**
 * Does any of these Discord processes run from this app folder? True when
 * any path is unknown: only a path we can read and that is elsewhere lets
 * the repair go ahead while Discord runs.
 */
export function pathsHoldInstall(paths: ReadonlyArray<string | null>, rootPath: string): boolean {
    const norm = (path: string): string => path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
    const root = `${norm(rootPath)}\\`;
    return paths.some(path => path === null || norm(path).startsWith(root));
}

/** Get-CimInstance for one image name. null when the lookup itself failed. */
export async function discordExecutablePaths(exec: Exec, imageName: string): Promise<Array<string | null> | null> {
    // The image name is ours (processNameFor), never user input; quoted anyway.
    const name = imageName.replace(/'/g, "''");
    try {
        const { stdout } = await exec("powershell.exe", [
            "-NoProfile", "-NonInteractive", "-Command",
            `Get-CimInstance Win32_Process -Filter "Name='${name}'" | ForEach-Object { if ($_.ExecutablePath) { $_.ExecutablePath } else { '?' } }`
        ]);
        return parseExecutablePaths(stdout);
    } catch {
        return null;
    }
}

