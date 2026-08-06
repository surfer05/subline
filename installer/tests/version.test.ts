import { unlinkSync, writeFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { readDiscordVersion } from "../src/patcher/version.js";
import type { Fixture } from "./fixture.js";
import { makeDiscordFixture } from "./fixture.js";

let fixture: Fixture | null = null;
afterEach(() => {
    fixture?.cleanup();
    fixture = null;
});

describe("readDiscordVersion", () => {
    it("reads version and channel from build_info.json", () => {
        fixture = makeDiscordFixture();
        const result = readDiscordVersion(fixture.install);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.version).toBe("0.0.406");
        expect(result.value.releaseChannel).toBe("stable");
        expect(result.value.raw.sentryDist).toBe("stable-osx-universal");
    });

    it("reports BUILD_INFO_MISSING when the file is absent", () => {
        fixture = makeDiscordFixture({ withoutBuildInfo: true });
        const result = readDiscordVersion(fixture.install);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("BUILD_INFO_MISSING");
    });

    it("reports BUILD_INFO_MALFORMED for unparsable JSON", () => {
        fixture = makeDiscordFixture();
        writeFileSync(fixture.install.buildInfoPath, "{not json");
        const result = readDiscordVersion(fixture.install);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("BUILD_INFO_MALFORMED");
    });

    it("reports BUILD_INFO_MALFORMED when version is missing", () => {
        fixture = makeDiscordFixture({ buildInfo: { releaseChannel: "stable" } });
        const result = readDiscordVersion(fixture.install);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("BUILD_INFO_MALFORMED");
    });

    it("does not throw when build_info.json disappears between checks", () => {
        fixture = makeDiscordFixture();
        unlinkSync(fixture.install.buildInfoPath);
        expect(() => readDiscordVersion(fixture!.install)).not.toThrow();
    });
});
