import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
    (globalThis as any).VencordNative = {
        pluginHelpers: {
            VcTranslate: {
                translateBatch: vi.fn(),
                readStagedBuildId: vi.fn().mockResolvedValue(null),
                relayStatus: vi.fn().mockResolvedValue({ ok: false, error: "status unavailable" })
            }
        }
    };
});

import plugin from "../index";
import { SURFACE_PATCHES } from "../surfaces/patches";
import { BUNDLE_EXCERPTS } from "./fixtures/discordBundleExcerpts";

/** Vencord's `\i` (an identifier), as its patcher expands it. */
function canon(match: RegExp): RegExp {
    const source = match.source.replaceAll(/(\\*)\\i/g, (m, lead: string) =>
        lead.length % 2 === 0 ? `${lead}(?:[A-Za-z_$][\\w$]*)` : m.slice(1));
    return new RegExp(source, match.flags);
}

describe("surface patches against Discord's current public bundle", () => {
    it("has an excerpt for every replacement", () => {
        const total = SURFACE_PATCHES.reduce((n, p) => n + p.replacement.length, 0);
        expect(BUNDLE_EXCERPTS).toHaveLength(total);
    });

    for (const ex of BUNDLE_EXCERPTS) {
        const patch = SURFACE_PATCHES[ex.patch];
        const r = patch.replacement[ex.replacement];
        it(`${patch.surface} [${ex.patch}.${ex.replacement}] matches exactly as checked (${ex.count}x in module ${ex.module})`, () => {
            const re = canon(r.match);
            const all = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
            expect([...ex.excerpt.matchAll(all)]).toHaveLength(ex.count);

            // The replacement changes the code, and calls a method the plugin has.
            const replaced = ex.excerpt.replace(re, r.replace.replaceAll("$self", "P"));
            expect(replaced).not.toBe(ex.excerpt);
            const called = [...r.replace.matchAll(/\$self\.(\w+)/g)].map(m => m[1]);
            for (const name of called) expect(typeof (plugin as any)[name], name).toBe("function");
        });
    }

    it("no patch is grouped, so one that stops matching never takes the others down", () => {
        for (const p of SURFACE_PATCHES) {
            expect((p as any).group).toBeUndefined();
            expect(p.find.length).toBeGreaterThan(8);
        }
    });

    it("the plugin ships exactly these patches", () => {
        expect((plugin as any).patches.map((p: any) => p.find)).toEqual(SURFACE_PATCHES.map(p => p.find));
    });

    it("wrapParser never throws while Discord loads its parser, whatever it is handed", () => {
        const wrap = (plugin as any).wrapParser;
        expect(wrap("topic", undefined)).toBeUndefined();
        expect(wrap("topic", 42)).toBe(42);
        const fn = () => ["parsed"];
        expect(typeof wrap("nonsense-kind", fn)).toBe("function");
        // Stopped plugin (no service): Discord's own output, untouched.
        const out = wrap("topic", fn)("Hallo zusammen");
        expect(out).toEqual(["parsed"]);
    });
});
