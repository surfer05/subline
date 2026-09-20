import { describe, expect, it } from "vitest";

import { shouldRelaunchForNewerBundle } from "../src/app/relaunch.js";

describe("shouldRelaunchForNewerBundle", () => {
    it("relaunches when the bundle on disk is not the one this process started with", () => {
        expect(shouldRelaunchForNewerBundle("build-1", "build-2")).toBe(true);
    });

    it("stays put when the bundle on disk is the one it started with", () => {
        expect(shouldRelaunchForNewerBundle("build-1", "build-1")).toBe(false);
    });

    it("stays put when the bundle on disk cannot be read", () => {
        expect(shouldRelaunchForNewerBundle("build-1", null)).toBe(false);
    });

    it("stays put when it does not know what it started with", () => {
        expect(shouldRelaunchForNewerBundle(null, "build-2")).toBe(false);
    });

    it("stays put when neither side is known", () => {
        expect(shouldRelaunchForNewerBundle(null, null)).toBe(false);
    });
});
