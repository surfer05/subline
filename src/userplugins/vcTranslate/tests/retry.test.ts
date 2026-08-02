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

    it("awaits the delay before making the next attempt", async () => {
        let release!: () => void;
        const gate = new Promise<void>(r => { release = r; });
        const sleep = vi.fn().mockReturnValue(gate);
        const fn = vi.fn()
            .mockRejectedValueOnce(new Error("boom"))
            .mockResolvedValue("ok");

        const p = withRetry(fn, { retries: 1, delayMs: 1000, sleep });

        // Let the first rejection and the sleep() call settle, but leave the
        // gate unresolved. If the implementation does not await sleep, it will
        // already have made the second attempt by now.
        await new Promise(r => setTimeout(r, 0));
        expect(sleep).toHaveBeenCalledWith(1000);
        expect(fn).toHaveBeenCalledTimes(1);

        release();
        await expect(p).resolves.toBe("ok");
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it("does not retry when shouldRetry returns false", async () => {
        const sleep = vi.fn().mockResolvedValue(undefined);
        const fn = vi.fn().mockRejectedValue(new Error("fatal"));
        await expect(
            withRetry(fn, { retries: 2, delayMs: 10, sleep, shouldRetry: () => false })
        ).rejects.toThrow("fatal");
        expect(fn).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
    });

    it("retries as usual when shouldRetry returns true", async () => {
        const fn = vi.fn()
            .mockRejectedValueOnce(new Error("boom"))
            .mockResolvedValue("ok");
        await expect(
            withRetry(fn, { retries: 1, delayMs: 10, sleep: noSleep, shouldRetry: () => true })
        ).resolves.toBe("ok");
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it("retries as before when shouldRetry is omitted (default behaviour)", async () => {
        const fn = vi.fn().mockRejectedValue(new Error("always fails"));
        await expect(withRetry(fn, { retries: 2, delayMs: 10, sleep: noSleep }))
            .rejects.toThrow("always fails");
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it("treats a negative retries count as zero and still throws a real error", async () => {
        const fn = vi.fn().mockRejectedValue(new Error("nope"));
        await expect(withRetry(fn, { retries: -1, delayMs: 10, sleep: noSleep }))
            .rejects.toThrow("nope");
        expect(fn).toHaveBeenCalledTimes(1);
    });
});
