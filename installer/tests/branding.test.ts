/**
 * The settings section a reader actually sees.
 *
 * WHAT THIS PROTECTS. Subline ships Vencord as its loader, and Vencord adds a
 * seven-entry section to Discord's settings — Vencord, Plugins, Themes,
 * Updater, Cloud, Backup & Restore, Patch Helper. Someone who installed a
 * translation tool opens Settings, finds a client-mod control panel, and
 * correctly concludes they were given something other than what was offered.
 * `brandSettings()` in buildMod.mjs reduces that to one entry.
 *
 * WHY THE ASSERTIONS ARE AGAINST THE BUILT `renderer.js` AND NOT THE SOURCE.
 * Because the first version of that function passed every source-level check it
 * had and still shipped the panes. It removed the ENTRIES and left the barrel
 * re-exporting the tab modules, so esbuild bundled Vencord's cloud-sync tab and
 * its backup/restore importer into the output — unreachable, but present and
 * greppable by anyone who cared to look. Source-level assertions could not see
 * that, because at the source level it was correct.
 *
 * So: the compiled artefact, or nothing.
 *
 * These skip rather than fail when no bundle has been built. `pnpm build:mod`
 * is a network build against a pinned commit, and a suite that cannot run
 * without one is a suite people stop running.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const INSTALLER_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const RENDERER = join(INSTALLER_DIR, "build", "mod", "renderer.js");

const built = existsSync(RENDERER);
const bundle = built ? readFileSync(RENDERER, "utf8") : "";

describe.skipIf(!built)("the built bundle's settings section", () => {
    it("builds exactly one entry, and it is Subline's", () => {
        expect(bundle).toContain('"subline_main"');

        // Each of Vencord's own entry keys. Asserted by KEY rather than by
        // title: a key is what the layout builder actually keys off, and it is
        // not a string that could plausibly appear for another reason.
        const vencordEntries = [
            "vencord_main", "vencord_plugins", "vencord_themes",
            "vencord_updater", "vencord_cloud", "vencord_backup_restore",
            "vencord_patch_helper"
        ];
        expect(vencordEntries.filter(key => bundle.includes(`"${key}"`))).toEqual([]);
    });

    it("does not carry the tab implementations it no longer reaches", () => {
        // Strings from inside the tab components themselves — the evidence that
        // the module was bundled, not merely that an entry named it. Every one
        // of these was present in the build that "removed" these panes.
        for (const marker of ["Backup & Restore", "Patch Helper", "Manage Themes"]) {
            expect(bundle, marker).not.toContain(marker);
        }
    });

    it("cannot reach Vencord's cloud sync, and says how it knows", () => {
        // The cloud sync CODE is still in the bundle: it lives in
        // api/SettingsSync, which Vencord.ts imports at startup, and cutting
        // that out means an anchored rewrite of Vencord.ts for a path that is
        // already dead. So the claim is not "the code is absent" — it is "the
        // code cannot run", and this is the evidence for it.
        //
        // Every branch in Vencord.ts's syncSettings() is gated on
        // `Settings.cloud.authenticated`. That is false by default, and the
        // only thing that ever set it was the Cloud tab's authorise button,
        // which is no longer built. Nothing else in the bundle writes it.
        expect(bundle).toContain("settingsSync:!1");

        // The one trace left is a DEEP LINK, not a pane: cloudSync raises a
        // notification whose button calls openUserSettings("vencord_cloud_panel"),
        // and that panel is no longer built. It is left alone deliberately —
        // rewriting Vencord.ts to excise a call that cannot execute buys
        // nothing and adds an anchor to maintain. If it ever DID fire it would
        // open nothing, which is a strictly better failure than syncing a
        // reader's settings to a server they were never told about.
        expect(bundle).toContain("vencord_cloud_panel");
    });

    it("still renders the plugin's own settings controls", () => {
        // The point of the whole exercise: the pane that replaced seven has to
        // contain something. These are vcTranslate's setting keys, which reach
        // renderer.js only because the Subline tab enumerates settings.def.
        for (const key of ["groqApiKey", "targetLang", "catchUpCount"]) {
            expect(bundle, key).toContain(key);
        }
    });

    it("is smaller than the bundle that shipped all seven panes", () => {
        // 241,429 bytes on 2026-08-24, before the panes came out; 218,570
        // after. A generous ceiling — this is here to catch the panes coming
        // BACK, which would add tens of kilobytes, not to police build size.
        expect(statSync(RENDERER).size).toBeLessThan(235_000);
    });
});

describe("the branding step itself", () => {
    const script = readFileSync(join(INSTALLER_DIR, "scripts", "buildMod.mjs"), "utf8");

    it("fails the build rather than silently branding nothing", () => {
        // The one outcome worth engineering against: a Vencord bump restructures
        // settings.tsx, every anchor misses, the rewrite is a no-op, and the
        // build still succeeds and still verifies — shipping Vencord's control
        // panel to a reader who was promised subtitles. Every anchor is checked
        // for EXACTLY ONE occurrence, and the result is re-read afterwards.
        expect(script).toContain("expected exactly one ${what}");
        expect(script).toContain("Settings section still builds");
        expect(script).toContain("does not build subline_main");
    });

    it("starts from a pristine Vencord tree on every run", () => {
        // brandSettings rewrites tracked files, and the checkout is REUSED
        // between builds. Without this restore the second build read the first
        // build's output as upstream source and failed on its own anchors —
        // observed, not hypothesised. prunePlugins survived the same reuse only
        // because delete-if-present is idempotent; an anchored rewrite cannot be.
        expect(script).toContain('run("git", ["checkout", "--force", "--", "."], VENCORD_DIR)');
    });
});
