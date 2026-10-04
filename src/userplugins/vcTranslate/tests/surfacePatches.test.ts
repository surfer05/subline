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
import { BUNDLE_SITES } from "./fixtures/discordBundleExcerpts";

/** Vencord's `\i` (an identifier), as its patcher expands it. */
function canon(match: RegExp): RegExp {
    const source = match.source.replaceAll(/(\\*)\\i/g, (m, lead: string) =>
        lead.length % 2 === 0 ? `${lead}(?:[A-Za-z_$][\\w$]*)` : m.slice(1));
    return new RegExp(source, match.flags);
}

describe("surface patches against Discord's current public bundle", () => {
    it("has the matched sites for every replacement", () => {
        const total = SURFACE_PATCHES.reduce((n, p) => n + p.replacement.length, 0);
        expect(BUNDLE_SITES).toHaveLength(total);
        // Minimal substrings only, never whole stretches of Discord's code.
        // The profile status bubble (394816) is the one exception: its match
        // looks ahead across the bubble's event handlers to the expandable
        // flag, so its sites run to about 300 characters.
        for (const e of BUNDLE_SITES) for (const site of e.sites) expect(site.length).toBeLessThan(e.module === "394816" ? 400 : 200);
    });

    for (const ex of BUNDLE_SITES) {
        const patch = SURFACE_PATCHES[ex.patch];
        const r = patch.replacement[ex.replacement];
        it(`${patch.surface} [${ex.patch}.${ex.replacement}] matches each checked site once (${ex.sites.length} in module ${ex.module})`, () => {
            const re = canon(r.match);
            const once = new RegExp(re.source, re.flags.replace("g", "") + "g");
            for (const site of ex.sites) {
                expect([...site.matchAll(once)]).toHaveLength(1);
                // The replacement changes the code, and calls a method the plugin has.
                const replaced = site.replace(re, r.replace.replaceAll("$self", "P"));
                expect(replaced).not.toBe(site);
            }
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

describe("the profile status line patch", () => {
    // Pieces of the bubble module (394816, 2026-10-04) in their real order:
    // the clamped status text, both return branches, and the outer component.
    const MODULE = [
        "ea=null!=r?(0,l.jsx)(f.E,{variant:\"text-sm/normal\",className:ex.qS,children:r}):null,",
        "return null==y?" + "(0,l.jsxs)(l.Fragment,{children:[eh,(0,l.jsxs)(\"div\",{ref:M,className:a()(ex.kL,E),onMouseEnter:()=>{I({action:\"HOVER_CUSTOM_STATUS\"}),ei(!0)},onMouseLeave:()=>{ei(!1)},children:[eT,C?.(z),eS]})" + "]}):",
        "(0,l.jsxs)(l.Fragment,{children:[eh,(0,l.jsxs)(\"div\",{ref:M,className:a()(ex.kL,E),onFocus:()=>{y(!0)},onBlur:e=>{M.current?.contains(e.relatedTarget)||y(!1)},onMouseEnter:()=>{I({action:\"HOVER_CUSTOM_STATUS\"}),y(!0),ei(!0)},onMouseLeave:()=>{y(!1),ei(!1)},children:[eT,C?.(z),eS]})" + "]})}),",
        "ev=i.forwardRef(function(e,t){let{user:n,disableToolbar:A=!1,...S}=e,C=(0,o.bG)([j.default],()=>j.default.getId()===n.id),",
        "I=!C&&!n.bot&&!A;if(g){let e=null!=R&&\"\"!==R?R:null;return(0,l.jsx)(E.f5,{value:h,children:(0,l.jsx)(ep,{emoji:c??null,text:e,statusLabel:L,placeholderText:d,ref:t,...S})" + "})}"
    ].join("");

    function patched(): string {
        const patch = SURFACE_PATCHES.find(p => p.find === "action:\"HOVER_CUSTOM_STATUS\"")!;
        let src = MODULE;
        for (const r of patch.replacement) src = src.replace(canon(r.match), r.replace);
        return src;
    }

    it("leaves the clamped status text exactly as Discord wrote it", () => {
        expect(patched()).toContain("className:ex.qS,children:r}):null,");
        expect(patched()).not.toContain("statusBubbleChildren");
    });

    it("puts the line in flow, between the reference container and the bubble, in both branches, with the expandable flag", () => {
        const src = patched();
        expect(src.match(/\$self\.statusLine\(arguments\[0\],z\)/g)).toHaveLength(2);
        expect(src).toContain("children:[eh,$self.statusLine(arguments[0],z),(0,l.jsxs)(\"div\",{ref:M");
    });

    it("marks the reader's own status on the props every branch passes on", () => {
        expect(patched()).toContain("if(S.sublineSelf=C,g){");
    });
});
