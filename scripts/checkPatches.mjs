#!/usr/bin/env node
/**
 * Check every webpack patch Subline ships against Discord's CURRENT public
 * web bundle, and fail loudly when one no longer applies.
 *
 * WHY. Vencord patches Discord's webpack modules by text: a patch names a
 * module by a `find` (a string or regex that must occur in the module's
 * source) and rewrites it with `replacement.match`. When Discord ships a new
 * build, a `find` can stop matching, match a second module, or a `match` can
 * stop matching. Vencord then only logs a warning in the user's DevTools, and
 * the feature silently disappears. That is exactly how v0.2.0 shipped with no
 * message popover buttons (Vencord's MessagePopoverAPI patch no longer
 * matched). This script is the guard: run before every release.
 *
 * WHAT IS CHECKED. The patches that actually ship and actually run:
 *   - every Vencord plugin buildMod.mjs keeps (installer/scripts/buildMod.mjs
 *     KEPT_PLUGIN_DIRS: _api, _core, clientTheme), taken from the pinned
 *     Vencord checkout in installer/build/vencord AFTER buildMod's source
 *     rewrites, and marked active the way Vencord's PluginManager decides it
 *     (required, enabledByDefault, a dependency, or an API a running plugin
 *     needs: messagePopoverButton needs MessagePopoverAPI, and so on);
 *   - Subline's own plugin (src/userplugins/vcTranslate: index.tsx and
 *     surfaces/patches.ts).
 * Inactive plugins are reported but never fail the check: their patches are
 * never applied.
 *
 * HOW, mirroring Vencord (src/webpack/patchWebpack.ts, src/utils/patches.ts
 * at the pinned commit):
 *   - finds and matches are canonicalised as Vencord does: `\i` becomes an
 *     identifier pattern and `#{intl::KEY}` becomes Discord's hashed key;
 *   - a `find` is tested against String(factory) of every webpack module;
 *     a normal patch must hit exactly ONE module (Vencord patches the first
 *     one it happens to load, so two hits is a coin toss), an `all` patch may
 *     hit any number;
 *   - replacements run in order on the progressively patched source; a
 *     non-global match must occur exactly once, a global one at least once
 *     (or exactly `expect` times when the replacement states it); `noWarn`
 *     replacements may have no effect.
 *
 * THE BUNDLE. https://discord.com/app (no cookies, no login) lists the
 * initial scripts; the webpack runtime in it maps every lazily loaded chunk
 * id to its file name. All of them are downloaded (a few hundred MB), each
 * chunk is evaluated in an empty VM context that only captures
 * `webpackChunkdiscord_app.push`, and the runtime's own inline modules are
 * cut out with the TypeScript parser. The download goes to a temporary
 * directory that is deleted afterwards unless --keep or --bundle-dir is used.
 *
 * Usage:
 *   node scripts/checkPatches.mjs                  # fetch, check, clean up
 *   node scripts/checkPatches.mjs --bundle-dir DIR # reuse / keep a download
 *   node scripts/checkPatches.mjs --json           # machine-readable rows
 * Exit code 0 when every active patch is OK, 1 on any FAIL, 2 on an error
 * (network, missing Vencord checkout).
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER = join(ROOT, "installer");
const DEFAULT_VENCORD = join(INSTALLER, "build", "vencord");
const DISCORD = "https://discord.com";

/* ================================================================ matcher == */

/**
 * Vencord's canonicalizeMatch (src/utils/patches.ts), with the intl hash
 * function passed in so the pure logic can be tested without xxhash.
 */
export function canonicalize(match, hashKey) {
    let partial = typeof match === "string" ? match : match.source;
    partial = partial.replaceAll(/#{intl::([\w$+/]*)(?:::(\w+))?}/g, (_, key, modifier) => {
        const hashed = modifier === "raw" ? key : hashKey(key);
        const isString = typeof match === "string";
        const special = !Number.isNaN(Number(hashed[0])) || hashed.includes("+") || hashed.includes("/");
        if (special) {
            return isString ? `["${hashed}"]` : String.raw`(?:\["${hashed}"\])`.replaceAll("+", "\\+");
        }
        return isString ? `.${hashed}` : String.raw`(?:\.${hashed})`;
    });
    if (typeof match === "string") return partial;
    const source = partial.replaceAll(/(\\*)\\i/g, (m, escapes) =>
        escapes.length % 2 === 0 ? `${escapes}${String.raw`(?:[A-Za-z_$][\w$]*)`}` : m.slice(1));
    return new RegExp(source, match.flags);
}

function findHits(find, code) {
    if (typeof find === "string") return code.includes(find);
    if (find.global) find.lastIndex = 0;
    return find.test(code);
}

function countMatches(match, code) {
    if (typeof match === "string") {
        let n = 0;
        for (let i = code.indexOf(match); i !== -1; i = code.indexOf(match, i + match.length)) n++;
        return n;
    }
    const flags = match.flags.includes("g") ? match.flags : match.flags + "g";
    const re = new RegExp(match.source, flags);
    let n = 0;
    for (const m of code.matchAll(re)) { n++; if (m[0] === "") break; }
    return n;
}

/** Apply one replacement as Vencord does; a replace function that throws leaves a marker. */
function applyReplacement(code, match, replace) {
    if (typeof match !== "string" && match.global) match.lastIndex = 0;
    try {
        return code.replace(match, replace);
    } catch {
        return code.replace(match, m => `${m}/*checkPatches: replace threw*/`);
    }
}

/**
 * Check one patch against the modules. `modules` is a Map of id → factory
 * source. Returns one row per replacement (or one row when the find fails).
 * Pure: everything it needs is passed in.
 */
export function checkPatch(patch, modules, { hashKey = k => k, pluginPath = "Vencord.Plugins.plugins[\"x\"]" } = {}) {
    const find = canonicalize(patch.find, hashKey);
    const hits = [];
    for (const [id, code] of modules) if (findHits(find, code)) hits.push(id);
    const replacements = Array.isArray(patch.replacement) ? patch.replacement : [patch.replacement];
    const base = { plugin: patch.plugin, find: String(patch.find), modules: hits.length, all: !!patch.all };

    if (hits.length === 0) {
        return [{ ...base, match: "", count: 0, ok: false, why: "find matches no module" }];
    }
    if (!patch.all && hits.length > 1) {
        return [{ ...base, match: "", count: 0, ok: false, why: `find matches ${hits.length} modules (${hits.slice(0, 5).join(", ")})` }];
    }

    const rows = [];
    // For an `all` patch each hit module is patched; report the totals.
    const perReplacement = replacements.map(() => ({ count: 0, applied: 0 }));
    for (const id of hits) {
        let code = modules.get(id);
        replacements.forEach((r, i) => {
            const match = canonicalize(r.match, hashKey);
            const n = countMatches(match, code);
            perReplacement[i].count += n;
            if (n > 0) {
                // A string replace is applied as Vencord would. A replace FUNCTION is never
                // called: it belongs to a plugin loaded with every import stubbed, and
                // one (ContextMenuAPI) loops forever on a stub. The matched text is kept
                // and marked instead, so the next replacement still sees a change.
                const replace = typeof r.replace === "string"
                    ? r.replace.replaceAll("$self", pluginPath)
                    : m => `${m}/*checkPatches*/`;
                const next = applyReplacement(code, match, replace);
                if (next !== code) perReplacement[i].applied++;
                code = next;
            }
        });
    }
    replacements.forEach((r, i) => {
        const match = canonicalize(r.match, hashKey);
        const global = typeof match !== "string" && match.global;
        const { count } = perReplacement[i];
        const noWarn = !!(patch.noWarn || r.noWarn);
        let ok;
        let why = "";
        if (typeof r.expect === "number") {
            ok = count === r.expect;
            if (!ok) why = `expected ${r.expect} matches, found ${count}`;
        } else if (patch.all) {
            ok = count > 0 || noWarn;
            if (!ok) why = "match found nowhere";
        } else if (global) {
            ok = count >= 1 || noWarn;
            if (!ok) why = "global match found nothing";
        } else {
            ok = count === 1 || (count === 0 && noWarn);
            if (!ok) why = count === 0 ? "match had no effect" : `match occurs ${count} times (only the first is patched)`;
        }
        rows.push({ ...base, match: String(r.match), count, ok, why });
    });
    return rows;
}

/* ========================================================= bundle loading == */

/** File names of every chunk the webpack runtime can load, from its `.u` function. */
export function lazyChunkFiles(runtimeSource) {
    const at = runtimeSource.indexOf(".u=e=>");
    if (at === -1) throw new Error("webpack runtime: no chunk filename function (.u=e=>) found");
    const start = at + 3;
    const end = runtimeSource.indexOf(",T.g=", start);
    const src = runtimeSource.slice(start, end === -1 ? runtimeSource.indexOf(";", start) : end);
    const u = vm.runInNewContext(`(${src})`);
    const ids = new Set();
    for (const m of src.matchAll(/"(\d+)"===e/g)) ids.add(m[1]);
    for (const m of src.matchAll(/(\d+):"[0-9a-f]{16}"/g)) ids.add(m[1]);
    const files = new Set();
    for (const id of ids) {
        const f = u(id);
        if (/^([\w-]+\.)?[0-9a-f]{16}\.js$/.test(f)) files.add(f);
    }
    return [...files];
}

/** Modules pushed by a chunk file: id → String(factory), exactly what Vencord tests. */
// ONE context for every chunk: a context per chunk (5,000+) kept gigabytes alive.
let chunkContext = null;
let chunkSink = null;
export function modulesFromChunk(source) {
    const out = new Map();
    if (chunkContext === null) {
        const chunks = [];
        chunks.push = (...items) => {
            for (const item of items) {
                const mods = Array.isArray(item) ? item[1] : null;
                if (mods && typeof mods === "object") for (const [id, fn] of Object.entries(mods)) chunkSink.set(id, String(fn));
            }
            return 0;
        };
        const sandbox = { webpackChunkdiscord_app: chunks };
        sandbox.self = sandbox;
        sandbox.window = sandbox;
        sandbox.globalThis = sandbox;
        chunkContext = vm.createContext(sandbox);
    }
    chunkSink = out;
    try {
        vm.runInContext(source, chunkContext, { timeout: 5_000 });
    } catch {
        // A chunk that does more than push (rare) still pushed first.
    }
    // Whatever a chunk left on the shared global (only the push array is used).
    chunkContext.webpackChunkdiscord_app.length = 0;
    return out;
}

/** The runtime's inline module table (webpack 5: `f={123(e,t,n){...},...}`), via the TS parser. */
export function modulesFromRuntime(source, ts) {
    const out = new Map();
    const sf = ts.createSourceFile("runtime.js", source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
    const visit = node => {
        if (ts.isObjectLiteralExpression(node) && node.properties.length > 0) {
            const props = node.properties;
            const isModuleTable = props.every(p => {
                const name = p.name && (ts.isNumericLiteral(p.name) || (ts.isStringLiteral(p.name) && /^\d+$/.test(p.name.text)));
                if (!name) return false;
                if (ts.isMethodDeclaration(p)) return true;
                return ts.isPropertyAssignment(p) && (ts.isFunctionExpression(p.initializer) || ts.isArrowFunction(p.initializer));
            });
            if (isModuleTable && props.length >= 3) {
                for (const p of props) {
                    const id = p.name.text;
                    const code = ts.isMethodDeclaration(p) ? p.getText(sf) : p.initializer.getText(sf);
                    out.set(id, code);
                }
                return;
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return out;
}

async function download(url, dest) {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (subline patch check)" } });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
            return;
        } catch (e) {
            if (attempt === 3) throw new Error(`download ${url} failed: ${e.message}`);
        }
    }
}

async function pool(items, size, fn) {
    let i = 0;
    const workers = Array.from({ length: size }, async () => {
        while (i < items.length) {
            const item = items[i++];
            await fn(item);
        }
    });
    await Promise.all(workers);
}

/** Download (or reuse) the whole public bundle into `dir`; returns { files, runtime }. */
export async function fetchBundle(dir, log = () => { }) {
    mkdirSync(dir, { recursive: true });
    const htmlPath = join(dir, "app.html");
    if (!existsSync(htmlPath)) await download(`${DISCORD}/app`, htmlPath);
    const html = readFileSync(htmlPath, "utf8");
    const initial = [...new Set([...html.matchAll(/(?:src|href)="\/assets\/([\w.-]+\.js)"/g)].map(m => m[1]))];
    const runtime = initial.find(f => /^web\.[0-9a-f]+\.js$/.test(f));
    if (!runtime) throw new Error("discord.com/app: no web.<hash>.js runtime script found");
    const have = new Set(readdirSync(dir));
    const missing = initial.filter(f => !have.has(f));
    log(`  ${initial.length} initial scripts (${missing.length} to download)`);
    await pool(missing, 24, f => download(`${DISCORD}/assets/${f}`, join(dir, f)));
    const lazy = lazyChunkFiles(readFileSync(join(dir, runtime), "utf8")).filter(f => !initial.includes(f));
    const have2 = new Set(readdirSync(dir));
    const missingLazy = lazy.filter(f => !have2.has(f));
    log(`  ${lazy.length} lazily loaded chunks (${missingLazy.length} to download)`);
    await pool(missingLazy, 24, f => download(`${DISCORD}/assets/${f}`, join(dir, f)));
    return { files: [...initial, ...lazy], runtime };
}

export function loadModules(dir, files, runtime, ts) {
    const modules = new Map();
    for (const f of files) {
        const src = readFileSync(join(dir, f), "utf8");
        const mods = f === runtime ? modulesFromRuntime(src, ts) : modulesFromChunk(src);
        for (const [id, code] of mods) modules.set(id, code);
    }
    return modules;
}

/* ========================================================= plugin loading == */

/** The Vencord plugin entry files under the kept plugin directories. */
export function keptPluginEntries(vencordDir, keptDirs) {
    const entries = [];
    const pluginsDir = join(vencordDir, "src", "plugins");
    const entryIn = d => ["index.ts", "index.tsx"].map(n => join(d, n)).find(existsSync);
    for (const kept of keptDirs) {
        const dir = join(pluginsDir, kept);
        if (!existsSync(dir)) throw new Error(`kept plugin dir missing: ${dir}`);
        const own = entryIn(dir);
        if (own) { entries.push(own); continue; }
        for (const name of readdirSync(dir)) {
            const p = join(dir, name);
            if (statSync(p).isDirectory()) { const e = entryIn(p); if (e) entries.push(e); }
            else if (/\.tsx?$/.test(name)) entries.push(p);
        }
    }
    return entries;
}

function keptDirsFromBuildMod() {
    const src = readFileSync(join(INSTALLER, "scripts", "buildMod.mjs"), "utf8");
    const m = src.match(/const KEPT_PLUGIN_DIRS = (\[[^\]]*\]);/);
    if (!m) throw new Error("installer/scripts/buildMod.mjs: KEPT_PLUGIN_DIRS not found");
    return JSON.parse(m[1]);
}

const STUB_RUNTIME = `
globalThis.__vcStub = function stub(name) {
    const target = function () { };
    const p = new Proxy(target, {
        get(t, k) {
            if (k === Symbol.toPrimitive) return () => "";
            if (k === "then") return undefined;
            if (k === "__esModule") return true;
            if (k === "default") return p;
            return p;
        },
        apply() { return p; },
        construct() { return p; },
        has() { return true; },
        // esbuild's __toESM copies OWN properties into an object whose prototype is
        // this one; a catch-all prototype keeps every named import resolvable.
        getPrototypeOf() { return catchAll; }
    });
    const catchAll = new Proxy({}, { get: () => p });
    return p;
};
globalThis.__vcJsx = globalThis.__vcStub("jsx");
globalThis.__vcFragment = globalThis.__vcStub("Fragment");
globalThis.__vcTypes = new Proxy({
    __esModule: true,
    default: x => x,
    definePluginSettings: () => globalThis.__vcStub("settings")
}, {
    get: (t, k) => k in t ? t[k] : globalThis.__vcStub(String(k)),
    getPrototypeOf: () => new Proxy({}, { get: (_, k) => globalThis.__vcStub(String(k)) })
});
`;

/** Bundle one plugin entry with esbuild, every Vencord/Discord import stubbed, and return the plugin object. */
async function loadPlugin(entry, esbuild) {
    const stubPlugin = {
        name: "stub-imports",
        setup(b) {
            b.onResolve({ filter: /^@utils\/types$/ }, () => ({ path: "types", namespace: "vc-types" }));
            b.onResolve({ filter: /\.(css|svg|png|gif|webp)(\?.*)?$|\?managed$|\?raw$/ }, a => ({ path: a.path, namespace: "vc-stub" }));
            b.onResolve({ filter: /^[^./]/ }, a => ({ path: a.path, namespace: "vc-stub" }));
            b.onLoad({ filter: /.*/, namespace: "vc-types" }, () => ({ contents: "module.exports = globalThis.__vcTypes;", loader: "js" }));
            b.onLoad({ filter: /.*/, namespace: "vc-stub" }, a => ({ contents: `module.exports = globalThis.__vcStub(${JSON.stringify(a.path)});`, loader: "js" }));
        }
    };
    const out = await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        write: false,
        format: "cjs",
        platform: "node",
        logLevel: "silent",
        jsx: "transform",
        jsxFactory: "__vcJsx",
        jsxFragment: "__vcFragment",
        define: {
            IS_WEB: "false", IS_EXTENSION: "false", IS_USERSCRIPT: "false", IS_STANDALONE: "true",
            IS_DEV: "false", IS_REPORTER: "false", IS_ANTI_CRASH_TEST: "false", IS_UPDATER_DISABLED: "true",
            IS_DISCORD_DESKTOP: "true", IS_VESKTOP: "false", VERSION: "\"0\"", BUILD_TIMESTAMP: "0"
        },
        plugins: [stubPlugin]
    });
    const code = out.outputFiles[0].text;
    const sandbox = { module: { exports: {} }, console: { log() { }, warn() { }, error() { }, info() { }, debug() { } }, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, URL, TextEncoder, TextDecoder };
    sandbox.exports = sandbox.module.exports;
    sandbox.globalThis = sandbox;
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(STUB_RUNTIME, sandbox);
    for (const g of ["VencordNative", "Vencord", "DiscordNative", "document", "navigator", "location", "localStorage", "sessionStorage", "performance", "requestAnimationFrame", "cancelAnimationFrame", "IntersectionObserver", "MutationObserver", "ResizeObserver", "HTMLElement", "Element", "Node", "Event", "CustomEvent", "fetch"]) {
        vm.runInContext(`globalThis[${JSON.stringify(g)}] = globalThis.__vcStub(${JSON.stringify(g)});`, sandbox);
    }
    vm.runInContext(code, sandbox, { filename: entry, timeout: 10_000 });
    const plugin = sandbox.module.exports.default ?? sandbox.module.exports;
    return plugin;
}

/** Which plugins Vencord actually starts, mirroring PluginManager.ts. */
export function activePlugins(plugins) {
    const byName = new Map(plugins.map(p => [p.name, p]));
    const active = new Set(plugins.filter(p => p.required || p.enabledByDefault || p.subline).map(p => p.name));
    let grew = true;
    while (grew) {
        grew = false;
        for (const name of [...active]) {
            const p = byName.get(name);
            const needs = [...(p?.dependencies ?? [])];
            if (p?.commands?.length) needs.push("CommandsAPI");
            if (p?.onBeforeMessageEdit || p?.onBeforeMessageSend || p?.onMessageClick) needs.push("MessageEventsAPI");
            if (p?.chatBarButton) needs.push("ChatInputButtonAPI");
            if (p?.renderMemberListDecorator) needs.push("MemberListDecoratorsAPI");
            if (p?.renderMessageAccessory) needs.push("MessageAccessoriesAPI");
            if (p?.renderMessageDecoration) needs.push("MessageDecorationsAPI");
            if (p?.messagePopoverButton) needs.push("MessagePopoverAPI");
            if (p?.userProfileBadge) needs.push("BadgeAPI");
            for (const n of needs) if (!active.has(n)) { active.add(n); grew = true; }
        }
    }
    return active;
}

/* ================================================================== main == */

function table(rows) {
    const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
    const lines = rows.map(r => [
        r.ok ? "OK  " : r.active ? "FAIL" : "off ",
        cut(r.active ? r.plugin : `${r.plugin} (off)`, 26).padEnd(26),
        cut(r.find, 44).padEnd(44),
        String(r.modules).padStart(3),
        String(r.count).padStart(3),
        cut(r.match, 50) + (r.why ? `  <- ${r.why}` : "")
    ].join("  "));
    return ["STAT  plugin                      find                                          mod  hit  match", ...lines].join("\n");
}

async function main(argv) {
    const arg = name => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };
    const json = argv.includes("--json");
    const keep = argv.includes("--keep");
    const vencordDir = resolve(arg("--vencord") ?? DEFAULT_VENCORD);
    const t0 = Date.now();
    const log = json ? () => { } : m => console.log(`${m}${m.startsWith(" ") ? "" : `  (${Math.round((Date.now() - t0) / 1000)}s)`}`);

    if (!existsSync(join(vencordDir, "node_modules"))) {
        console.error(`checkPatches: no built Vencord checkout at ${vencordDir}. Run \`pnpm build:mod\` in installer/ first.`);
        return 2;
    }
    const vreq = createRequire(join(vencordDir, "package.json"));
    const esbuild = vreq("esbuild");
    const { hash: h64 } = await import(pathToFileURL(vreq.resolve("@intrnl/xxhash64")).href);
    const hashKey = key => runtimeHashMessageKey(key, h64);
    const ts = createRequire(join(INSTALLER, "package.json"))("typescript");

    log("1/3  Loading the patches that ship");
    const entries = keptPluginEntries(vencordDir, keptDirsFromBuildMod());
    const plugins = [];
    for (const entry of entries) {
        const p = await loadPlugin(entry, esbuild);
        if (p && p.name) plugins.push(p);
    }
    const subline = join(vencordDir, "src", "userplugins", "vcTranslate", "index.tsx");
    const sublineEntry = existsSync(subline) ? subline : join(ROOT, "src", "userplugins", "vcTranslate", "index.tsx");
    const sp = await loadPlugin(sublineEntry, esbuild);
    sp.subline = true;
    plugins.push(sp);
    const active = activePlugins(plugins);
    log(`     ${plugins.length} plugins, ${plugins.reduce((n, p) => n + (p.patches?.length ?? 0), 0)} patches, ${[...active].length} active`);

    log("2/3  Fetching Discord's public web bundle");
    const bundleArg = arg("--bundle-dir");
    const dir = bundleArg ? resolve(bundleArg) : mkdtempSync(join(tmpdir(), "subline-discord-bundle-"));
    let modules;
    try {
        const { files, runtime } = await fetchBundle(dir, log);
        modules = loadModules(dir, files, runtime, ts);
        log(`     ${modules.size} webpack modules`);
    } finally {
        if (!bundleArg && !keep) rmSync(dir, { recursive: true, force: true });
    }

    log("3/3  Checking every patch");
    const rows = [];
    for (const p of plugins) {
        if (process.env.CHECKPATCHES_TRACE) console.error(`  checking ${p.name} at ${Math.round((Date.now() - t0) / 1000)}s, heap ${Math.round(process.memoryUsage().heapUsed / 1e6)} MB`);
        for (const patch of p.patches ?? []) {
            const res = checkPatch({ ...patch, plugin: p.name }, modules, {
                hashKey,
                pluginPath: `Vencord.Plugins.plugins[${JSON.stringify(p.name)}]`
            });
            for (const r of res) rows.push({ ...r, active: active.has(p.name), predicate: typeof patch.predicate === "function" });
        }
    }
    const failed = rows.filter(r => !r.ok && r.active);
    if (json) console.log(JSON.stringify({ ok: failed.length === 0, modules: modules.size, rows }, null, 2));
    else {
        console.log(table(rows));
        console.log(failed.length === 0
            ? `\nAll ${rows.filter(r => r.active).length} active patch checks pass against ${modules.size} modules.`
            : `\n${failed.length} active patch check(s) FAILED. Discord changed under these patches; fix them before releasing.`);
    }
    return failed.length === 0 ? 0 : 1;
}

/** Vencord's runtimeHashMessageKey (src/utils/intlHash.ts), with the xxhash64 function passed in. */
export function runtimeHashMessageKey(key, h64) {
    const TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".split("");
    const hash = BigInt(h64(key, 0));
    const bytes = [];
    const byteCount = Math.ceil(Math.floor(Math.log2(Number(hash)) + 1) / 8);
    for (let i = 0; i < byteCount; i++) bytes.unshift(Number((hash >> BigInt(8 * i)) & 255n));
    // Vencord reverses on little-endian machines (every machine this runs on).
    const b = new Uint8Array(bytes).reverse();
    return [
        TABLE[b[0] >> 2], TABLE[((b[0] & 0x03) << 4) | (b[1] >> 4)], TABLE[((b[1] & 0x0f) << 2) | (b[2] >> 6)],
        TABLE[b[2] & 0x3f], TABLE[b[3] >> 2], TABLE[((b[3] & 0x03) << 4) | (b[4] >> 4)]
    ].join("");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2)).then(code => process.exit(code), e => {
        console.error(`checkPatches: ${e?.stack ?? e}`);
        process.exit(2);
    });
}
