/**
 * No console window, ever. Node's execFile shows one on Windows unless
 * `windowsHide: true` is passed, and the helper (a console-less app started
 * every 5 minutes) flashed tasklist and schtasks windows over whatever the
 * user was doing. These fail if the option is dropped, or if a new call site
 * spawns a console program without going through hiddenExec.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { HIDDEN_EXEC_OPTIONS, hiddenExec } from "../src/patcher/exec.js";

describe("hiddenExec", () => {
    it("passes windowsHide: true on every call", async () => {
        const seen: unknown[] = [];
        const exec = hiddenExec((_file, _args, options, callback) => {
            seen.push(options);
            callback(null, "out", "");
            return undefined;
        });
        const result = await exec("tasklist", ["/FO", "CSV", "/NH"]);
        expect(result.stdout).toBe("out");
        expect(seen).toEqual([{ ...HIDDEN_EXEC_OPTIONS }]);
        expect((seen[0] as { windowsHide: boolean }).windowsHide).toBe(true);
    });

    it("rejects with what the program said on stderr, so the cause is logged", async () => {
        const exec = hiddenExec((_file, _args, _options, callback) => {
            callback(Object.assign(new Error("Command failed"), { code: 1 }), "", "ERROR: The system cannot find the file specified.");
            return undefined;
        });
        await expect(exec("schtasks", ["/Query"])).rejects.toMatchObject({ stderr: "ERROR: The system cannot find the file specified." });
    });
});

describe("every console program goes through hiddenExec", () => {
    function files(dir: string): string[] {
        return readdirSync(dir).flatMap(name => {
            const path = join(dir, name);
            return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
        });
    }
    const src = join(import.meta.dirname, "..", "src");

    it("no file but patcher/exec.ts imports execFile", () => {
        const offenders = files(src)
            .filter(path => !path.endsWith(join("patcher", "exec.ts")))
            .filter(path => /\bexecFile\b/.test(readFileSync(path, "utf8").replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "")))
            .map(path => relative(src, path));
        expect(offenders).toEqual([]);
    });

    it("every spawn() states its window handling", () => {
        const offenders: string[] = [];
        for (const path of files(src)) {
            const text = readFileSync(path, "utf8");
            for (const match of text.matchAll(/\bspawn\(([^;]*?)\);/gs)) {
                if (!/windowsHide/.test(match[1] ?? "")) offenders.push(`${relative(src, path)}: ${match[0].slice(0, 60)}`);
            }
        }
        expect(offenders).toEqual([]);
    });
});
