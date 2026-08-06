import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MARKER_FORMAT, writeMarker } from "../src/patcher/marker.js";
import { inspectInstall } from "../src/patcher/state.js";
import { buildStubAsar } from "../src/patcher/stub.js";
import type { Fixture } from "./fixture.js";
import { makeDiscordFixture } from "./fixture.js";

const OUR_LOADER = "/Applications/Subline.app/Contents/Resources/loader/patcher.js";

let fixture: Fixture | null = null;
afterEach(() => {
    fixture?.cleanup();
    fixture = null;
});

/** Put our stub and a matching marker in place without going through patchInstall. */
function markAsOurs(f: Fixture, loaderPath = OUR_LOADER): void {
    writeFileSync(f.install.asarPath, buildStubAsar(loaderPath));
    writeMarker(f.install.resourcesPath, {
        format: MARKER_FORMAT,
        product: "subline",
        productVersion: "0.0.0",
        loaderPath,
        pluginBuildId: "1f2e3d4c5b6a7980",
        discordVersion: "0.0.406",
        backupPath: f.install.backupPath,
        patchedAt: new Date().toISOString()
    });
}

describe("inspectInstall", () => {
    it("reports a clean install as unpatched", () => {
        fixture = makeDiscordFixture();
        const result = inspectInstall(fixture.install);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.kind).toBe("unpatched");
        expect(result.value.mod).toBeNull();
        expect(result.value.hasBackup).toBe(false);
        expect(result.value.asarIsStub).toBe(false);
        expect(result.value.warnings).toEqual([]);
    });

    it("reports our own patch as patched-by-us with the loader path", () => {
        fixture = makeDiscordFixture({ withBackup: true });
        markAsOurs(fixture);

        const result = inspectInstall(fixture.install);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.kind).toBe("patched-by-us");
        expect(result.value.mod).toBe("subline");
        expect(result.value.loaderPath).toBe(OUR_LOADER);
        expect(result.value.marker?.discordVersion).toBe("0.0.406");
    });

    it("names Vencord distinctly rather than reporting a generic 'already patched'", () => {
        fixture = makeDiscordFixture({
            withBackup: true,
            stubLoaderPath: "/Users/someone/dev/Vencord/dist/patcher.js"
        });

        const result = inspectInstall(fixture.install);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.kind).toBe("patched-by-other");
        expect(result.value.mod).toBe("vencord");
        expect(result.value.modName).toBe("Vencord");
        expect(result.value.summary).toContain("Vencord");
    });

    it("distinguishes Equicord from Vencord", () => {
        fixture = makeDiscordFixture({
            withBackup: true,
            stubLoaderPath: "/Users/someone/Library/Application Support/Equicord/dist/patcher.js"
        });
        const result = inspectInstall(fixture.install);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.kind).toBe("patched-by-other");
        expect(result.value.mod).toBe("equicord");
    });

    it("detects BetterDiscord's unpacked resources/app folder on an untouched app.asar", () => {
        fixture = makeDiscordFixture({ withUnpackedAppDir: true });
        const result = inspectInstall(fixture.install);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.kind).toBe("patched-by-other");
        expect(result.value.mod).toBe("betterdiscord");
    });

    it("reports an unrecognised mod as patched-by-other, not as ours", () => {
        fixture = makeDiscordFixture({ withBackup: true, stubLoaderPath: "/opt/mystery/loader.js" });
        const result = inspectInstall(fixture.install);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.kind).toBe("patched-by-other");
        expect(result.value.mod).toBe("unknown");
        expect(result.value.summary).toContain("/opt/mystery/loader.js");
    });

    it("does not claim ownership of a stub just because our marker is present", () => {
        // A foreign installer ran after us: our marker survives, the stub does not.
        fixture = makeDiscordFixture({ withBackup: true });
        markAsOurs(fixture);
        writeFileSync(fixture.install.asarPath, buildStubAsar("/Users/someone/dev/Vencord/dist/patcher.js"));

        const result = inspectInstall(fixture.install);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.kind).toBe("patched-by-other");
        expect(result.value.mod).toBe("vencord");
        expect(result.value.warnings).toContain("marker-loader-mismatch");
    });

    it("detects the half-patched state where app.asar is gone but the backup survives", () => {
        fixture = makeDiscordFixture({ withoutAsar: true, withBackup: true });
        const result = inspectInstall(fixture.install);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.kind).toBe("broken");
        expect(result.value.reason).toBe("asar-missing-backup-present");
        expect(result.value.hasBackup).toBe(true);
    });

    it("detects the unrecoverable state where neither archive exists", () => {
        fixture = makeDiscordFixture({ withoutAsar: true });
        const result = inspectInstall(fixture.install);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.kind).toBe("broken");
        expect(result.value.reason).toBe("asar-and-backup-missing");
    });

    it("detects our patch with a missing backup as broken, not as healthy", () => {
        fixture = makeDiscordFixture({ withBackup: true });
        markAsOurs(fixture);
        unlinkSync(fixture.install.backupPath);

        const result = inspectInstall(fixture.install);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.kind).toBe("broken");
        expect(result.value.reason).toBe("our-patch-without-backup");
    });

    it("detects a foreign patch with no preserved original as broken", () => {
        fixture = makeDiscordFixture({ stubLoaderPath: "/Users/someone/dev/Vencord/dist/patcher.js" });
        const result = inspectInstall(fixture.install);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.kind).toBe("broken");
        expect(result.value.reason).toBe("foreign-patch-without-backup");
        expect(result.value.modName).toBe("Vencord");
    });

    it("flags a leftover backup beside a genuine app.asar as a stale-backup warning", () => {
        // What a Discord update leaves behind: a fresh real app.asar plus the
        // old mod's _app.asar (spec §7, "Discord updated, patch orphaned").
        fixture = makeDiscordFixture({ withBackup: true });
        const result = inspectInstall(fixture.install);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.kind).toBe("unpatched");
        expect(result.value.warnings).toContain("stale-backup");
    });

    it("reports a corrupt app.asar as broken rather than unpatched", () => {
        fixture = makeDiscordFixture();
        writeFileSync(fixture.install.asarPath, Buffer.from("not an archive"));
        const result = inspectInstall(fixture.install);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.kind).toBe("broken");
        expect(result.value.reason).toBe("asar-unreadable");
    });

    it("reports a mangled marker as broken rather than silently ignoring it", () => {
        fixture = makeDiscordFixture({ withBackup: true });
        markAsOurs(fixture);
        writeFileSync(join(fixture.install.resourcesPath, "subline-patch.json"), "{oops");

        const result = inspectInstall(fixture.install);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.kind).toBe("broken");
        expect(result.value.reason).toBe("marker-unreadable");
    });

    it("errors when the path is not a Discord install at all", () => {
        fixture = makeDiscordFixture();
        const bogus = { ...fixture.install, resourcesPath: join(fixture.root, "nowhere") };
        const result = inspectInstall(bogus);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("NOT_A_DISCORD_INSTALL");
    });
});
