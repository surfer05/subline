import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SETTINGS_COPY } from "../settingsCopy";
import { IN_PLACE_COPY, UPGRADE_COPY } from "../upgradeCopy";

/**
 * Owner rule: a reader never sees "VcTranslate". The product is Subline and
 * its settings are "Subline → Settings". "VcTranslate" survives only as an
 * internal identifier: the Vencord plugin name, logger tags, DataStore keys
 * and component ids, each an exact identifier string, never a sentence.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Every shipped source file (tests excluded). */
function sources(dir = ROOT): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (name === "tests" || name === "node_modules") continue;
        if (statSync(path).isDirectory()) out.push(...sources(path));
        else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(path);
    }
    return out;
}

/** Comments out, so a doc comment that names the plugin is not counted. */
function withoutComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

/** Identifiers that are not copy: the plugin name, DataStore keys, component ids. */
const IDENTIFIER = /^VcTranslate(_[A-Za-z0-9_]+|-forceQuality|Surfaces)?$/;

describe("no user-visible VcTranslate", () => {
    it("no string or template literal in the shipped sources says VcTranslate, except as a bare identifier", () => {
        const offenders: string[] = [];
        for (const file of sources()) {
            const src = withoutComments(readFileSync(file, "utf8"));
            for (const m of src.matchAll(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g)) {
                const body = m[0].slice(1, -1);
                if (body.includes("VcTranslate") && !IDENTIFIER.test(body)) offenders.push(`${file.slice(ROOT.length)}: ${m[0].slice(0, 80)}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it("the copy modules never say it", () => {
        const all = JSON.stringify([UPGRADE_COPY, SETTINGS_COPY, IN_PLACE_COPY]);
        expect(all).not.toContain("VcTranslate");
    });
});
