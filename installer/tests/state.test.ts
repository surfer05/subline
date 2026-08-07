import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MARKER_FORMAT, readMarker, writeMarker } from "../src/patcher/marker.js";
import { inspectInstall } from "../src/patcher/state.js";
import { buildStubAsar } from "../src/patcher/stub.js";
import type { Fixture } from "./fixture.js";
import {
    foreignOriginalAsarBytes,
    makeDiscordFixture,
    REAL_VENCORD_LOADER_PATH,
    realVencordStubBytes
} from "./fixture.js";

const OUR_LOADER = "/Applications/Subline.app/Contents/Resources/loader/patcher.js";
const OUR_BUILD_ID = "1f2e3d4c5b6a7980";

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
        pluginBuildId: OUR_BUILD_ID,
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

    it("calls the REAL live Vencord app.asar a foreign mod, not a broken install", () => {
        // End-to-end on the exact 199 bytes Vencord's own installer wrote to
        // /Applications/Discord.app on this machine, assembled from literals
        // rather than from buildStubAsar — see fixture.ts.
        //
        // Every other inspectInstall test here writes its app.asar with our own
        // writer, so all of them would still pass if the reader only understood
        // archives we produced. This one would not. Getting it wrong reports a
        // healthy Vencord install as damaged and steers the user to repair or
        // uninstall instead of spec §3 step 4's "detect, explain, let them
        // choose".
        fixture = makeDiscordFixture({ withBackup: true });
        writeFileSync(fixture.install.asarPath, realVencordStubBytes());

        const result = inspectInstall(fixture.install);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.kind).toBe("patched-by-other");
        expect(result.value.reason).toBeNull();
        expect(result.value.mod).toBe("vencord");
        expect(result.value.modName).toBe("Vencord");
        expect(result.value.loaderPath).toBe(REAL_VENCORD_LOADER_PATH);
        expect(result.value.asarIsStub).toBe(true);
        expect(result.value.summary).toContain("Vencord");
    });

    it("calls a foreign-written Discord archive unpatched, not a stub and not broken", () => {
        // The other half: an original archive in the form a real asar writer
        // emits (padded header, nested dirs, integrity, unpacked and link
        // entries) must read as Discord's own, so a clean install is not
        // mistaken for someone's injection.
        fixture = makeDiscordFixture();
        writeFileSync(fixture.install.asarPath, foreignOriginalAsarBytes());

        const result = inspectInstall(fixture.install);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.kind).toBe("unpatched");
        expect(result.value.reason).toBeNull();
        expect(result.value.mod).toBeNull();
        expect(result.value.asarIsStub).toBe(false);
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

    it("separates 'we could not open it' from 'the archive is damaged'", () => {
        // A real user hit this: their Discord was a perfectly healthy Vencord
        // install, but the packaged app could not OPEN app.asar (Electron
        // treats ".asar" paths as archives to mount rather than files to read).
        // We announced "Discord needs repairing" and offered repair and
        // Uninstall for a file that was never broken. An unopenable archive and
        // a corrupt one call for opposite remedies, so they must not share a
        // reason.
        //
        // A directory where app.asar should be makes openSync fail with EISDIR:
        // an IO error, with the bytes never examined at all.
        fixture = makeDiscordFixture();
        unlinkSync(fixture.install.asarPath);
        mkdirSync(fixture.install.asarPath);

        const result = inspectInstall(fixture.install);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.kind).toBe("broken");
        expect(result.value.reason).toBe("asar-inaccessible");
        // And the wording must not accuse Discord of being damaged.
        expect(result.value.summary).toContain("could not open");
        expect(result.value.summary).not.toContain("could not be read as an archive");
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

    it("keeps the build identity the marker records", () => {
        fixture = makeDiscordFixture({ withBackup: true });
        markAsOurs(fixture);
        const marker = readMarker(fixture.install.resourcesPath);
        expect(marker.ok && marker.value?.pluginBuildId).toBe(OUR_BUILD_ID);
    });

    it("reads a malformed build identity as absent rather than passing it through", () => {
        // This value decides whether a running plugin is the one we installed.
        // A marker on disk is editable, so a string that is not a digest must
        // arrive as "we cannot say which build", never as an id that something
        // could be compared equal to.
        fixture = makeDiscordFixture({ withBackup: true });
        for (const pluginBuildId of ["", "unknown", "*", "1F2E3D4C5B6A7980", "1f2e3d4", 7, null, {}]) {
            markAsOurs(fixture);
            const path = join(fixture.install.resourcesPath, "subline-patch.json");
            const marker = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
            marker.pluginBuildId = pluginBuildId;
            writeFileSync(path, JSON.stringify(marker, null, 4));

            const read = readMarker(fixture.install.resourcesPath);
            expect(read.ok).toBe(true);
            expect(read.ok && read.value?.pluginBuildId).toBeNull();
        }
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
