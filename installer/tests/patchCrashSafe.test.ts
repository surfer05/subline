/**
 * Audit 2026-10-06 #10, #13, #16: the patch never leaves a moment without
 * app.asar, retries a rename an antivirus scan holds (Windows only), checks
 * the backup it will keep before writing, and Uninstall repairs an unreadable
 * app.asar from our own backup.
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { markerPathFor } from "../src/patcher/marker.js";
import { patchInstall, unpatchInstall } from "../src/patcher/patch.js";
import type { PatchOptions } from "../src/patcher/patch.js";
import { inspectInstall } from "../src/patcher/state.js";
import { buildStubAsar } from "../src/patcher/stub.js";
import type { Fixture, ModBundleFixture } from "./fixture.js";
import { makeDiscordFixture, makeModBundleFixture } from "./fixture.js";

let fixture: Fixture;
let bundle: ModBundleFixture;

beforeEach(() => {
    bundle = makeModBundleFixture({ buildId: "1f2e3d4c5b6a7980" });
});
afterEach(() => {
    fixture?.cleanup();
    bundle.cleanup();
});

function options(extra: Partial<PatchOptions> = {}): PatchOptions {
    return { modBundleDir: bundle.dir, productVersion: "1.2.3", ...extra };
}

function locked(): Error {
    return Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
}

describe("crash-safe backup (audit #10)", () => {
    it("app.asar is still Discord's original after the backup is made and before the stub goes in", () => {
        fixture = makeDiscordFixture();
        let seen: { asar: Buffer | null; backup: Buffer | null } | null = null;
        const result = patchInstall(fixture.install, options({
            hooks: {
                afterBackup: ({ asarPath, backupPath }) => {
                    seen = {
                        asar: existsSync(asarPath) ? readFileSync(asarPath) : null,
                        backup: existsSync(backupPath) ? readFileSync(backupPath) : null
                    };
                }
            }
        }));
        expect(result.ok).toBe(true);
        expect(seen).not.toBeNull();
        expect(seen!.asar?.equals(fixture.originalAsar)).toBe(true);
        expect(seen!.backup?.equals(fixture.originalAsar)).toBe(true);
        expect(readFileSync(fixture.install.backupPath).equals(fixture.originalAsar)).toBe(true);
        expect(readFileSync(fixture.install.asarPath).equals(buildStubAsar(bundle.loaderPath))).toBe(true);
    });

    it("falls back to a copy when a hard link is not possible", () => {
        fixture = makeDiscordFixture();
        const result = patchInstall(fixture.install, options({
            hooks: { link: () => { throw Object.assign(new Error("EXDEV"), { code: "EXDEV" }); } }
        }));
        expect(result.ok).toBe(true);
        expect(readFileSync(fixture.install.backupPath).equals(fixture.originalAsar)).toBe(true);
    });

    it("a failed install of the stub leaves the original at app.asar and no backup behind", () => {
        fixture = makeDiscordFixture();
        const result = patchInstall(fixture.install, options({
            hooks: {
                platform: "darwin",
                rename: (from, to) => {
                    if (to === fixture.install.asarPath) throw Object.assign(new Error("EIO"), { code: "EIO" });
                    renameSync(from, to);
                }
            }
        }));
        expect(result.ok).toBe(false);
        expect(readFileSync(fixture.install.asarPath).equals(fixture.originalAsar)).toBe(true);
        expect(existsSync(fixture.install.backupPath)).toBe(false);
        expect(existsSync(markerPathFor(fixture.install.resourcesPath))).toBe(false);
    });
});

describe("antivirus locks are retried on Windows (audit #16)", () => {
    it("EPERM once on the stub rename, then success: patched", () => {
        fixture = makeDiscordFixture();
        let failures = 0;
        const sleeps: number[] = [];
        const result = patchInstall(fixture.install, options({
            hooks: {
                platform: "win32",
                sleepSync: ms => sleeps.push(ms),
                rename: (from, to) => {
                    if (to === fixture.install.asarPath && failures === 0) {
                        failures += 1;
                        throw locked();
                    }
                    renameSync(from, to);
                }
            }
        }));
        expect(result.ok).toBe(true);
        expect(sleeps).toEqual([100]);
        expect(readFileSync(fixture.install.backupPath).equals(fixture.originalAsar)).toBe(true);
    });

    it("a lock that never clears: the write error, not ROLLBACK_FAILED, with Discord's original in place, even when the rollback is held once", () => {
        fixture = makeDiscordFixture();
        let unlinkFailures = 0;
        const result = patchInstall(fixture.install, options({
            hooks: {
                platform: "win32",
                sleepSync: () => {},
                rename: (from, to) => {
                    if (to === fixture.install.asarPath) throw locked();
                    renameSync(from, to);
                },
                unlink: path => {
                    if (path === fixture.install.backupPath && unlinkFailures === 0) {
                        unlinkFailures += 1;
                        throw locked();
                    }
                    unlinkSync(path);
                }
            }
        }));
        expect(result.ok).toBe(false);
        // The write error itself (FILE_IN_USE on Windows), never ROLLBACK_FAILED.
        if (!result.ok) expect(result.error.code).not.toBe("ROLLBACK_FAILED");
        expect(readFileSync(fixture.install.asarPath).equals(fixture.originalAsar)).toBe(true);
        expect(existsSync(fixture.install.backupPath)).toBe(false);
    });

    it("macOS does not retry: a real error comes back at once", () => {
        fixture = makeDiscordFixture();
        let calls = 0;
        const result = patchInstall(fixture.install, options({
            hooks: {
                platform: "darwin",
                sleepSync: () => { throw new Error("must not sleep"); },
                rename: (from, to) => {
                    if (to === fixture.install.asarPath) {
                        calls += 1;
                        throw locked();
                    }
                    renameSync(from, to);
                }
            }
        }));
        expect(result.ok).toBe(false);
        expect(calls).toBe(1);
        expect(readFileSync(fixture.install.asarPath).equals(fixture.originalAsar)).toBe(true);
    });

    it("Uninstall's restore rename is retried on Windows too", () => {
        fixture = makeDiscordFixture();
        expect(patchInstall(fixture.install, options()).ok).toBe(true);
        let failures = 0;
        const result = unpatchInstall(fixture.install, {
            ownLoaderPaths: [bundle.loaderPath],
            hooks: {
                platform: "win32",
                sleepSync: () => {},
                rename: (from, to) => {
                    if (failures < 2) {
                        failures += 1;
                        throw locked();
                    }
                    renameSync(from, to);
                }
            }
        });
        expect(result.ok).toBe(true);
        expect(readFileSync(fixture.install.asarPath).equals(fixture.originalAsar)).toBe(true);
    });
});

describe("the backup the patch keeps is checked first (audit #13)", () => {
    it("a stub in _app.asar under another mod's stub: BACKUP_CORRUPT, nothing written", () => {
        fixture = makeDiscordFixture({ stubLoaderPath: "/Users/someone/dev/Vencord/dist/patcher.js" });
        writeFileSync(fixture.install.backupPath, buildStubAsar("/Users/someone/other/patcher.js"));
        const before = readFileSync(fixture.install.asarPath);
        const result = patchInstall(fixture.install, options({ overwriteForeignMod: true }));
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.code).toBe("BACKUP_CORRUPT");
            expect(result.error.message).toContain("Reinstall Discord");
        }
        expect(readFileSync(fixture.install.asarPath).equals(before)).toBe(true);
        expect(existsSync(join(fixture.install.resourcesPath, ".subline-app.asar.tmp"))).toBe(false);
    });
});

describe("Uninstall repairs an unreadable app.asar from our backup (audit #13)", () => {
    it("truncated app.asar + our marker + Discord's original in _app.asar: restored", () => {
        fixture = makeDiscordFixture();
        expect(patchInstall(fixture.install, options()).ok).toBe(true);
        // Discord's own updater left a truncated file where our stub was.
        writeFileSync(fixture.install.asarPath, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]));
        const state = inspectInstall(fixture.install, { ownLoaderPaths: [bundle.loaderPath] });
        expect(state.ok && state.value.kind === "broken" && state.value.reason).toBe("asar-unreadable");
        if (state.ok) expect(state.value.summary).toContain("Press Uninstall");

        const result = unpatchInstall(fixture.install, { ownLoaderPaths: [bundle.loaderPath] });
        expect(result.ok).toBe(true);
        expect(readFileSync(fixture.install.asarPath).equals(fixture.originalAsar)).toBe(true);
        expect(existsSync(markerPathFor(fixture.install.resourcesPath))).toBe(false);
    });

    it("truncated app.asar with no marker of ours is still left alone", () => {
        fixture = makeDiscordFixture({ withBackup: true });
        writeFileSync(fixture.install.asarPath, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]));
        const result = unpatchInstall(fixture.install, {});
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe("BROKEN_INSTALL");
        expect(readFileSync(fixture.install.backupPath).equals(fixture.originalAsar)).toBe(true);
    });

    it("every unrecoverable broken summary names a remedy", () => {
        fixture = makeDiscordFixture({ withoutAsar: true });
        const gone = inspectInstall(fixture.install);
        expect(gone.ok && gone.value.summary).toContain("Reinstall Discord from discord.com");
    });
});
