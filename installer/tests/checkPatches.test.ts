/**
 * scripts/checkPatches.mjs: the release guard that checks every shipped
 * webpack patch against Discord's public bundle. These tests run its matcher
 * on small synthetic modules, so they need no network and no Vencord build.
 */

import { createRequire } from "node:module";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
    activePlugins, canonicalize, checkPatch, lazyChunkFiles, modulesFromChunk, modulesFromRuntime
} from "../../scripts/checkPatches.mjs";

const ts = createRequire(join(import.meta.dirname, "..", "package.json"))("typescript");

const hashKey = (k: string) => `H${k.length}`;
const mods = (o: Record<string, string>) => new Map(Object.entries(o));

describe("canonicalize, as Vencord does", () => {
    it("turns \\i into an identifier pattern and keeps an escaped \\\\i literal", () => {
        const re = canonicalize(/^(\i)\.foo\(\i\)$/, hashKey) as RegExp;
        expect(re.test("aB$1.foo(x)")).toBe(true);
        expect(re.test("1a.foo(x)")).toBe(false);
        expect((canonicalize(/a\\i/, hashKey) as RegExp).source).toBe("a\\i");
    });

    it("hashes #{intl::KEY} in strings and regexes, and keeps ::raw keys", () => {
        expect(canonicalize("#{intl::HELLO}),children", hashKey)).toBe(".H5),children");
        expect(canonicalize("#{intl::abc::raw}", hashKey)).toBe(".abc");
        expect(canonicalize("#{intl::1x::raw}", hashKey)).toBe("[\"1x\"]");
        expect((canonicalize(/#{intl::HELLO}/, hashKey) as RegExp).test("a.H5")).toBe(true);
    });

    it("keeps the regex flags", () => {
        expect((canonicalize(/x/gs, hashKey) as RegExp).flags).toBe("gs");
    });
});

describe("checkPatch", () => {
    const modules = mods({
        1: "function(e,t,n){let a=renderButton(x),b=togglePopout:y}",
        2: "function(e,t,n){navId:\"a\",items:[1]}",
        3: "function(e,t,n){navId:\"b\",navId:\"c\"}",
        4: "function(e,t,n){foo();foo();}"
    });

    it("passes a find that hits exactly one module and a match that occurs once", () => {
        const rows = checkPatch({ plugin: "P", find: "togglePopout:", replacement: { match: /renderButton\((\i)\)/, replace: "X($1)" } }, modules);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ ok: true, modules: 1, count: 1 });
    });

    it("fails a find that hits no module", () => {
        const [row] = checkPatch({ plugin: "P", find: "notThere", replacement: { match: /x/, replace: "y" } }, modules);
        expect(row).toMatchObject({ ok: false, modules: 0 });
        expect(row!.why).toMatch(/no module/);
    });

    it("fails a find that hits two modules (Vencord would patch whichever loads first)", () => {
        const [row] = checkPatch({ plugin: "P", find: "navId:", replacement: { match: /items/, replace: "y" } }, modules);
        expect(row).toMatchObject({ ok: false, modules: 2 });
        expect(row!.why).toMatch(/2 modules/);
    });

    it("allows many modules for an `all` patch and counts the matches in each", () => {
        const [row] = checkPatch({ plugin: "P", find: "navId:", all: true, replacement: { match: /navId:/g, replace: "N:" } }, modules);
        expect(row).toMatchObject({ ok: true, modules: 2, count: 3 });
    });

    it("fails a non-global match that has no effect, or occurs twice", () => {
        const none = checkPatch({ plugin: "P", find: "togglePopout:", replacement: { match: /missing/, replace: "y" } }, modules);
        expect(none[0]).toMatchObject({ ok: false, count: 0 });
        const twice = checkPatch({ plugin: "P", find: "foo();foo()", replacement: { match: /foo\(\)/, replace: "bar()" } }, modules);
        expect(twice[0]).toMatchObject({ ok: false, count: 2 });
        expect(twice[0]!.why).toMatch(/2 times/);
    });

    it("passes a global match found at least once, and honours an explicit expect count", () => {
        expect(checkPatch({ plugin: "P", find: "foo();foo()", replacement: { match: /foo\(\)/g, replace: "bar()" } }, modules)[0]!.ok).toBe(true);
        expect(checkPatch({ plugin: "P", find: "foo();foo()", replacement: { match: /foo\(\)/g, replace: "b()", expect: 2 } }, modules)[0]!.ok).toBe(true);
        expect(checkPatch({ plugin: "P", find: "foo();foo()", replacement: { match: /foo\(\)/g, replace: "b()", expect: 3 } }, modules)[0]!.ok).toBe(false);
    });

    it("lets a noWarn replacement have no effect", () => {
        expect(checkPatch({ plugin: "P", find: "togglePopout:", noWarn: true, replacement: { match: /missing/, replace: "y" } }, modules)[0]!.ok).toBe(true);
    });

    it("runs replacements in order on the patched code, as Vencord does", () => {
        const rows = checkPatch({
            plugin: "P", find: "togglePopout:",
            replacement: [
                { match: /renderButton/, replace: "wrapped" },
                { match: /wrapped\(x\)/, replace: "done" }
            ]
        }, modules);
        expect(rows.map(r => r.ok)).toEqual([true, true]);
    });

    it("never calls a replace function (plugins are loaded with stubbed imports)", () => {
        let called = false;
        const rows = checkPatch({ plugin: "P", find: "togglePopout:", replacement: { match: /renderButton/, replace: () => { called = true; return "z"; } } }, modules);
        expect(rows[0]!.ok).toBe(true);
        expect(called).toBe(false);
    });

    it("canonicalises the find too (intl keys)", () => {
        const m = mods({ 9: "function(){x.H5),children:[]}" });
        expect(checkPatch({ plugin: "P", find: "#{intl::HELLO}),children", replacement: { match: /children/, replace: "c" } }, m, { hashKey })[0]!.ok).toBe(true);
    });
});

describe("reading the bundle", () => {
    it("lists every lazily loaded chunk the webpack runtime can load", () => {
        const runtime = "x;T.u=e=>\"11\"===e?\"\"+e+\".aaaaaaaaaaaaaaaa.js\":\"\"+({22:\"bbbbbbbbbbbbbbbb\",33:\"cccccccccccccccc\"})[e]+\".js\",T.g=1;";
        expect(lazyChunkFiles(runtime).sort()).toEqual(["11.aaaaaaaaaaaaaaaa.js", "bbbbbbbbbbbbbbbb.js", "cccccccccccccccc.js"]);
    });

    it("takes a chunk's modules as String(factory), exactly what Vencord tests", () => {
        const src = "(this.webpackChunkdiscord_app=this.webpackChunkdiscord_app||[]).push([[5],{101(e,t,n){n.d(t,{a:()=>1})},102:function(e){e.exports=2}}]);";
        const m = modulesFromChunk(src);
        expect([...m.keys()]).toEqual(["101", "102"]);
        expect(m.get("101")).toBe("101(e,t,n){n.d(t,{a:()=>1})}");
        expect(m.get("102")).toBe("function(e){e.exports=2}");
    });

    it("cuts the runtime's inline module table out with the parser", () => {
        const src = "(()=>{var f={1(e){a()},2(e,t){b()},3:function(e){c()}},g={x:1};start()})();";
        const m = modulesFromRuntime(src, ts);
        expect([...m.keys()]).toEqual(["1", "2", "3"]);
        expect(m.get("2")).toBe("2(e,t){b()}");
    });
});

describe("which plugins run", () => {
    it("mirrors PluginManager: required, enabledByDefault, Subline, and the APIs they need", () => {
        const active = activePlugins([
            { name: "Req", required: true },
            { name: "Off" },
            { name: "MessagePopoverAPI" },
            { name: "ChatInputButtonAPI" },
            { name: "Dep" },
            { name: "Sub", subline: true, messagePopoverButton: {}, chatBarButton: {}, dependencies: ["Dep"] }
        ]);
        expect([...active].sort()).toEqual(["ChatInputButtonAPI", "Dep", "MessagePopoverAPI", "Req", "Sub"]);
    });
});

describe("the release runs it", () => {
    it("checks every patch right after build:mod, skippable only with --skip-patch-check", async () => {
        const { readFileSync } = await import("node:fs");
        const src = readFileSync(join(import.meta.dirname, "..", "scripts", "release.mjs"), "utf8");
        const build = src.indexOf("sh(\"pnpm\", [\"build:mod\"])");
        const check = src.indexOf("\"checkPatches.mjs\"");
        expect(build).toBeGreaterThan(0);
        expect(check).toBeGreaterThan(build);
        expect(src).toContain("skipPatchCheck: has(\"--skip-patch-check\")");
        expect(src.slice(check - 300, check)).toContain("if (options.skipPatchCheck)");
    });

    it("is a pnpm script at the root and in the installer", async () => {
        const { readFileSync } = await import("node:fs");
        const root = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf8"));
        const inst = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
        expect(root.scripts["check:patches"]).toBe("node scripts/checkPatches.mjs");
        expect(inst.scripts["check:patches"]).toBe("node ../scripts/checkPatches.mjs");
    });
});
