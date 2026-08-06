import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildAsar } from "../src/patcher/asar.js";
import { markerPathFor, readMarker } from "../src/patcher/marker.js";
import { patchInstall, unpatchInstall } from "../src/patcher/patch.js";
import { inspectInstall } from "../src/patcher/state.js";
import { buildStubAsar, readStub, STUB_PACKAGE_JSON, stubIndexSource } from "../src/patcher/stub.js";
import type { Fixture } from "./fixture.js";
import { makeDiscordFixture } from "./fixture.js";

const LOADER = "/Applications/Subline.app/Contents/Resources/loader/patcher.js";
const OTHER_LOADER = "/Applications/Subline.app/Contents/Resources/loader/patcher-v2.js";
const VENCORD_LOADER = "/Users/someone/dev/Vencord/dist/patcher.js";

const OPTIONS = { loaderPath: LOADER, productVersion: "1.2.3" };

let fixture: Fixture | null = null;
afterEach(() => {
    if (fixture) {
        // Some tests chmod the resources dir to force EACCES; put it back so
        // the temp tree can be removed.
        try {
            chmodSync(fixture.install.resourcesPath, 0o755);
        } catch {
            /* not every test changes it */
        }
        fixture.cleanup();
    }
    fixture = null;
});

function sha256(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("patchInstall", () => {
    it("patches an unpatched install and verifies what it wrote", () => {
        fixture = makeDiscordFixture();
        const originalHash = sha256(fixture.install.asarPath);

        const result = patchInstall(fixture.install, OPTIONS);
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.value.backupCreated).toBe(true);
        expect(result.value.alreadyPatched).toBe(false);
        expect(result.value.previousState).toBe("unpatched");
        expect(result.value.discordVersion).toBe("0.0.406");

        // The original is preserved byte for byte under _app.asar.
        expect(sha256(fixture.install.backupPath)).toBe(originalHash);

        // app.asar is exactly the stub, in the same shape the real install has.
        expect(readFileSync(fixture.install.asarPath).equals(buildStubAsar(LOADER))).toBe(true);
        const stub = readStub(fixture.install.asarPath);
        expect(stub.ok).toBe(true);
        if (!stub.ok || stub.value === null) throw new Error("expected a stub");
        expect(stub.value.indexSource).toBe(stubIndexSource(LOADER));
        expect(stub.value.packageJson).toBe(STUB_PACKAGE_JSON);

        const state = inspectInstall(fixture.install);
        expect(state.ok && state.value.kind).toBe("patched-by-us");

        const marker = readMarker(fixture.install.resourcesPath);
        expect(marker.ok).toBe(true);
        if (!marker.ok || marker.value === null) throw new Error("expected a marker");
        expect(marker.value.loaderPath).toBe(LOADER);
        expect(marker.value.productVersion).toBe("1.2.3");
        expect(marker.value.discordVersion).toBe("0.0.406");
    });

    it("leaves no temp files behind", () => {
        fixture = makeDiscordFixture();
        expect(patchInstall(fixture.install, OPTIONS).ok).toBe(true);
        const stray = readdirSync(fixture.install.resourcesPath).filter(name => name.includes("tmp"));
        expect(stray).toEqual([]);
    });

    it("is idempotent: patching an already-patched install writes nothing", () => {
        fixture = makeDiscordFixture();
        expect(patchInstall(fixture.install, OPTIONS).ok).toBe(true);
        const backupHash = sha256(fixture.install.backupPath);
        const asarHash = sha256(fixture.install.asarPath);

        const again = patchInstall(fixture.install, OPTIONS);
        expect(again.ok).toBe(true);
        if (!again.ok) return;
        expect(again.value.alreadyPatched).toBe(true);
        expect(again.value.backupCreated).toBe(false);
        expect(sha256(fixture.install.backupPath)).toBe(backupHash);
        expect(sha256(fixture.install.asarPath)).toBe(asarHash);
    });

    it("re-points to a new loader without disturbing the preserved original", () => {
        fixture = makeDiscordFixture();
        expect(patchInstall(fixture.install, OPTIONS).ok).toBe(true);
        const backupHash = sha256(fixture.install.backupPath);

        const repoint = patchInstall(fixture.install, { ...OPTIONS, loaderPath: OTHER_LOADER });
        expect(repoint.ok).toBe(true);
        if (!repoint.ok) return;
        expect(repoint.value.backupCreated).toBe(false);
        expect(sha256(fixture.install.backupPath)).toBe(backupHash);

        const stub = readStub(fixture.install.asarPath);
        if (!stub.ok || stub.value === null) throw new Error("expected a stub");
        expect(stub.value.loaderPath).toBe(OTHER_LOADER);
    });

    it("refuses to patch over another mod without consent, and changes nothing", () => {
        fixture = makeDiscordFixture({ withBackup: true, stubLoaderPath: VENCORD_LOADER });
        const asarHash = sha256(fixture.install.asarPath);
        const backupHash = sha256(fixture.install.backupPath);

        const result = patchInstall(fixture.install, OPTIONS);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("FOREIGN_MOD_PRESENT");
        expect(result.error.message).toContain("Vencord");

        expect(sha256(fixture.install.asarPath)).toBe(asarHash);
        expect(sha256(fixture.install.backupPath)).toBe(backupHash);
        expect(existsSync(markerPathFor(fixture.install.resourcesPath))).toBe(false);
    });

    it("patches over another mod when the user opts in, keeping THEIR backup as the original", () => {
        fixture = makeDiscordFixture({ withBackup: true, stubLoaderPath: VENCORD_LOADER });
        const originalHash = sha256(fixture.install.backupPath);

        const result = patchInstall(fixture.install, { ...OPTIONS, overwriteForeignMod: true });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.replacedMod).toBe("vencord");
        // Critical: their _app.asar is Discord's real code. It must survive
        // untouched — overwriting it with their stub would destroy the original.
        expect(result.value.backupCreated).toBe(false);
        expect(sha256(fixture.install.backupPath)).toBe(originalHash);

        const stub = readStub(fixture.install.asarPath);
        if (!stub.ok || stub.value === null) throw new Error("expected a stub");
        expect(stub.value.loaderPath).toBe(LOADER);
    });

    it("refuses BetterDiscord's unpacked app folder even with consent, because the patch would do nothing", () => {
        fixture = makeDiscordFixture({ withUnpackedAppDir: true });
        const result = patchInstall(fixture.install, { ...OPTIONS, overwriteForeignMod: true });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("FOREIGN_MOD_PRESENT");
        expect(result.error.message).toContain("resources/app");
        expect(existsSync(fixture.install.backupPath)).toBe(false);
    });

    it("refuses to patch a broken install", () => {
        fixture = makeDiscordFixture({ withoutAsar: true, withBackup: true });
        const result = patchInstall(fixture.install, OPTIONS);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("BROKEN_INSTALL");
        expect(existsSync(fixture.install.asarPath)).toBe(false);
    });

    it("overwrites a stale leftover backup when the real app.asar is in place", () => {
        // Discord updated and orphaned an old patch: app.asar is genuine again
        // but a stale _app.asar remains. The genuine one must become the backup.
        fixture = makeDiscordFixture({ withBackup: true });
        writeFileSync(fixture.install.backupPath, buildStubAsar("/stale/leftover.js"));
        const genuineHash = sha256(fixture.install.asarPath);

        const result = patchInstall(fixture.install, OPTIONS);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.backupCreated).toBe(true);
        expect(sha256(fixture.install.backupPath)).toBe(genuineHash);
    });

    it("returns PERMISSION_DENIED, not a stack trace, when the directory is not writable", () => {
        fixture = makeDiscordFixture();
        const asarHash = sha256(fixture.install.asarPath);
        chmodSync(fixture.install.resourcesPath, 0o555);

        const result = patchInstall(fixture.install, OPTIONS);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("PERMISSION_DENIED");

        chmodSync(fixture.install.resourcesPath, 0o755);
        expect(sha256(fixture.install.asarPath)).toBe(asarHash);
        expect(existsSync(fixture.install.backupPath)).toBe(false);
    });
});

describe("patchInstall rollback", () => {
    it("rolls back to the untouched original when verification fails", () => {
        fixture = makeDiscordFixture();
        const originalHash = sha256(fixture.install.asarPath);

        const result = patchInstall(fixture.install, {
            ...OPTIONS,
            hooks: {
                // Simulate a write that silently did not land as intended.
                afterWrite: ({ asarPath }) => writeFileSync(asarPath, buildStubAsar("/wrong/loader.js"))
            }
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("VERIFICATION_FAILED");

        // Discord is exactly as it was: original archive, no backup, no marker.
        expect(sha256(fixture.install.asarPath)).toBe(originalHash);
        expect(existsSync(fixture.install.backupPath)).toBe(false);
        expect(existsSync(markerPathFor(fixture.install.resourcesPath))).toBe(false);

        const state = inspectInstall(fixture.install);
        expect(state.ok && state.value.kind).toBe("unpatched");
    });

    it("rolls back a corrupted write to the untouched original", () => {
        fixture = makeDiscordFixture();
        const originalHash = sha256(fixture.install.asarPath);

        const result = patchInstall(fixture.install, {
            ...OPTIONS,
            hooks: { afterWrite: ({ asarPath }) => writeFileSync(asarPath, Buffer.from("truncated garbage")) }
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("VERIFICATION_FAILED");
        expect(sha256(fixture.install.asarPath)).toBe(originalHash);
        expect(existsSync(fixture.install.backupPath)).toBe(false);
    });

    it("rolls back an archive that parses correctly but is not byte-identical", () => {
        // Same two files, same contents, different entry order — every
        // structural check passes and only the byte comparison catches it.
        // This is what "verify by reading back" has to mean to be worth having.
        fixture = makeDiscordFixture();
        const originalHash = sha256(fixture.install.asarPath);
        const reordered = buildAsar([
            { name: "package.json", content: Buffer.from(STUB_PACKAGE_JSON, "utf8") },
            { name: "index.js", content: Buffer.from(stubIndexSource(LOADER), "utf8") }
        ]);

        const result = patchInstall(fixture.install, {
            ...OPTIONS,
            hooks: { afterWrite: ({ asarPath }) => writeFileSync(asarPath, reordered) }
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("VERIFICATION_FAILED");
        expect(sha256(fixture.install.asarPath)).toBe(originalHash);
        expect(existsSync(fixture.install.backupPath)).toBe(false);
    });

    it("cleans up the staged temp file when the backup step fails", () => {
        // `_app.asar` occupied by a directory makes the backup rename fail
        // after the temp file has already been staged.
        fixture = makeDiscordFixture();
        const asarHash = sha256(fixture.install.asarPath);
        mkdirSync(join(fixture.install.backupPath, "occupied"), { recursive: true });

        const result = patchInstall(fixture.install, OPTIONS);
        expect(result.ok).toBe(false);
        if (result.ok) return;

        expect(sha256(fixture.install.asarPath)).toBe(asarHash);
        const stray = readdirSync(fixture.install.resourcesPath).filter(name => name.includes("tmp"));
        expect(stray).toEqual([]);
    });

    it("rolls back a failed re-point by restoring the previous stub exactly", () => {
        fixture = makeDiscordFixture();
        expect(patchInstall(fixture.install, OPTIONS).ok).toBe(true);
        const stubHash = sha256(fixture.install.asarPath);
        const backupHash = sha256(fixture.install.backupPath);
        const markerBefore = readFileSync(markerPathFor(fixture.install.resourcesPath), "utf8");

        const result = patchInstall(fixture.install, {
            ...OPTIONS,
            loaderPath: OTHER_LOADER,
            hooks: { afterWrite: ({ asarPath }) => writeFileSync(asarPath, Buffer.from("garbage")) }
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("VERIFICATION_FAILED");
        expect(sha256(fixture.install.asarPath)).toBe(stubHash);
        expect(sha256(fixture.install.backupPath)).toBe(backupHash);
        expect(readFileSync(markerPathFor(fixture.install.resourcesPath), "utf8")).toBe(markerBefore);

        const state = inspectInstall(fixture.install);
        expect(state.ok && state.value.kind).toBe("patched-by-us");
        expect(state.ok && state.value.loaderPath).toBe(LOADER);
    });

    it("reports ROLLBACK_FAILED loudly, with the backup location, when it cannot undo", () => {
        fixture = makeDiscordFixture();

        const result = patchInstall(fixture.install, {
            ...OPTIONS,
            hooks: {
                afterWrite: ({ asarPath, backupPath }) => {
                    // Verification will fail, and the backup we would restore
                    // from has been destroyed underneath us.
                    writeFileSync(asarPath, Buffer.from("garbage"));
                    unlinkSync(backupPath);
                }
            }
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("ROLLBACK_FAILED");
        expect(result.error.message).toContain(fixture.install.backupPath);
    });
});

describe("unpatchInstall", () => {
    it("restores a byte-identical original and removes our artefacts", () => {
        fixture = makeDiscordFixture();
        const originalHash = sha256(fixture.install.asarPath);
        expect(patchInstall(fixture.install, OPTIONS).ok).toBe(true);

        const result = unpatchInstall(fixture.install);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.restored).toBe(true);
        expect(result.value.previousState).toBe("patched-by-us");
        expect(result.value.removedArtifacts).toContain(markerPathFor(fixture.install.resourcesPath));

        expect(sha256(fixture.install.asarPath)).toBe(originalHash);
        expect(readFileSync(fixture.install.asarPath).equals(fixture.originalAsar)).toBe(true);
        expect(existsSync(fixture.install.backupPath)).toBe(false);
        expect(existsSync(markerPathFor(fixture.install.resourcesPath))).toBe(false);

        const state = inspectInstall(fixture.install);
        expect(state.ok && state.value.kind).toBe("unpatched");
        expect(state.ok && state.value.warnings).toEqual([]);
    });

    it("fails loudly with BACKUP_MISSING and keeps Discord launchable when the backup is gone", () => {
        fixture = makeDiscordFixture();
        expect(patchInstall(fixture.install, OPTIONS).ok).toBe(true);
        unlinkSync(fixture.install.backupPath);

        const result = unpatchInstall(fixture.install);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("BACKUP_MISSING");
        expect(result.error.message).toContain(fixture.install.backupPath);
        expect(result.error.message).toMatch(/reinstall/i);

        // We must not have deleted app.asar as a consolation prize.
        expect(existsSync(fixture.install.asarPath)).toBe(true);
    });

    it("refuses BACKUP_CORRUPT rather than moving a bad backup over app.asar", () => {
        fixture = makeDiscordFixture();
        expect(patchInstall(fixture.install, OPTIONS).ok).toBe(true);
        writeFileSync(fixture.install.backupPath, buildStubAsar("/some/other/stub.js"));
        const asarHash = sha256(fixture.install.asarPath);

        const result = unpatchInstall(fixture.install);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("BACKUP_CORRUPT");
        expect(sha256(fixture.install.asarPath)).toBe(asarHash);
        expect(existsSync(fixture.install.backupPath)).toBe(true);
    });

    it("repairs the half-patched state by finishing the restore", () => {
        fixture = makeDiscordFixture();
        const originalHash = sha256(fixture.install.asarPath);
        expect(patchInstall(fixture.install, OPTIONS).ok).toBe(true);
        // Simulate an interrupted patch: app.asar gone, backup present.
        unlinkSync(fixture.install.asarPath);

        const result = unpatchInstall(fixture.install);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.restored).toBe(true);
        expect(result.value.previousState).toBe("broken");
        expect(sha256(fixture.install.asarPath)).toBe(originalHash);
        expect(existsSync(fixture.install.backupPath)).toBe(false);
    });

    it("reports alreadyClean on an untouched install", () => {
        fixture = makeDiscordFixture();
        const result = unpatchInstall(fixture.install);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.alreadyClean).toBe(true);
        expect(result.value.restored).toBe(false);
        expect(result.value.removedArtifacts).toEqual([]);
    });

    it("refuses to uninstall another mod on the user's behalf", () => {
        fixture = makeDiscordFixture({ withBackup: true, stubLoaderPath: VENCORD_LOADER });
        const asarHash = sha256(fixture.install.asarPath);

        const result = unpatchInstall(fixture.install);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("FOREIGN_MOD_PRESENT");
        expect(result.error.message).toContain("Vencord");
        expect(sha256(fixture.install.asarPath)).toBe(asarHash);
        expect(existsSync(fixture.install.backupPath)).toBe(true);
    });

    it("restores Discord from another mod's patch when explicitly asked", () => {
        fixture = makeDiscordFixture({ withBackup: true, stubLoaderPath: VENCORD_LOADER });
        const originalHash = sha256(fixture.install.backupPath);

        const result = unpatchInstall(fixture.install, { removeForeignMod: true });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.restored).toBe(true);
        expect(sha256(fixture.install.asarPath)).toBe(originalHash);
    });

    it("sweeps up a leftover backup and marker on an install Discord already restored", () => {
        fixture = makeDiscordFixture();
        expect(patchInstall(fixture.install, OPTIONS).ok).toBe(true);
        // A Discord update dropped a fresh real app.asar over our stub.
        writeFileSync(fixture.install.asarPath, fixture.originalAsar);

        const result = unpatchInstall(fixture.install);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.restored).toBe(false);
        expect(result.value.alreadyClean).toBe(false);
        expect(result.value.removedArtifacts).toContain(fixture.install.backupPath);
        expect(result.value.removedArtifacts).toContain(markerPathFor(fixture.install.resourcesPath));
        expect(existsSync(fixture.install.backupPath)).toBe(false);
    });

    it("leaves another mod's leftover backup alone", () => {
        // A stale _app.asar with no marker of ours is not ours to delete.
        fixture = makeDiscordFixture({ withBackup: true });
        const result = unpatchInstall(fixture.install);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.removedArtifacts).toEqual([]);
        expect(existsSync(fixture.install.backupPath)).toBe(true);
    });

    it("reports BACKUP_MISSING when neither archive exists", () => {
        fixture = makeDiscordFixture({ withoutAsar: true });
        const result = unpatchInstall(fixture.install);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("BACKUP_MISSING");
    });
});

describe("patch → unpatch → patch cycle", () => {
    it("returns Discord to byte-identical state each time round", () => {
        fixture = makeDiscordFixture();
        const originalHash = sha256(fixture.install.asarPath);

        for (let i = 0; i < 3; i++) {
            expect(patchInstall(fixture.install, OPTIONS).ok).toBe(true);
            expect(sha256(fixture.install.asarPath)).not.toBe(originalHash);
            expect(unpatchInstall(fixture.install).ok).toBe(true);
            expect(sha256(fixture.install.asarPath)).toBe(originalHash);
        }

        expect(readdirSync(fixture.install.resourcesPath).sort()).toEqual(["app.asar", "build_info.json"]);
        expect(existsSync(join(fixture.install.resourcesPath, "_app.asar"))).toBe(false);
    });
});
