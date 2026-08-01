import { describe, expect, it, vi } from "vitest";
import { withRetry } from "../retry";

const noSleep = () => Promise.resolve();

describe("withRetry", () => {
    it("returns the value when the first attempt succeeds", async () => {
        const fn = vi.fn().mockResolvedValue("ok");
        await expect(withRetry(fn, { retries: 1, delayMs: 10, sleep: noSleep })).resolves.toBe("ok");
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it("retries once and succeeds on the second attempt", async () => {
        const fn = vi.fn()
            .mockRejectedValueOnce(new Error("boom"))
            .mockResolvedValue("ok");
        await expect(withRetry(fn, { retries: 1, delayMs: 10, sleep: noSleep })).resolves.toBe("ok");
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it("gives up after exhausting retries and rethrows the last error", async () => {
        const fn = vi.fn().mockRejectedValue(new Error("always fails"));
        await expect(withRetry(fn, { retries: 2, delayMs: 10, sleep: noSleep }))
            .rejects.toThrow("always fails");
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it("waits between attempts", async () => {
        const sleep = vi.fn().mockResolvedValue(undefined);
        const fn = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValue("ok");
        await withRetry(fn, { retries: 1, delayMs: 1000, sleep });
        expect(sleep).toHaveBeenCalledWith(1000);
    });
});
