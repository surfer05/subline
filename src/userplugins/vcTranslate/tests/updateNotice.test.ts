import { describe, expect, it } from "vitest";

import { createUpdateWatch, shouldPromptRestart, type UpdateWatchDeps } from "../updateNotice";

const RUNNING = "76241bd61131b98c";
const NEWER = "aa11bb22cc33dd44";

describe("shouldPromptRestart", () => {
    it("prompts when a different, well-formed build is staged", () => {
        expect(shouldPromptRestart(RUNNING, NEWER)).toBe(true);
    });

    it("does not prompt when the staged build is the one running", () => {
        expect(shouldPromptRestart(RUNNING, RUNNING)).toBe(false);
    });

    it("does not prompt when nothing is staged (null)", () => {
        expect(shouldPromptRestart(RUNNING, null)).toBe(false);
    });
});

/**
 * A watch with hand-controlled time and a scripted disk reader, so each tick is
 * explicit. `tick()` fires the single interval callback the watch registered.
 */
function harness(reads: Array<string | null | Error>) {
    let prompts = 0;
    let intervalFn: (() => void) | null = null;
    let cleared = 0;
    let readIndex = 0;

    const deps: UpdateWatchDeps = {
        runningBuildId: RUNNING,
        readStagedBuildId: () => {
            const r = reads[Math.min(readIndex, reads.length - 1)];
            readIndex += 1;
            return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
        },
        onUpdateStaged: () => { prompts += 1; },
        intervalMs: 1000,
        setInterval: fn => { intervalFn = fn as () => void; return 1; },
        clearInterval: () => { cleared += 1; intervalFn = null; }
    };

    const watch = createUpdateWatch(deps);
    return {
        watch,
        tick: async () => { intervalFn?.(); await flush(); },
        get prompts() { return prompts; },
        get cleared() { return cleared; },
        get armed() { return intervalFn !== null; }
    };
}

// Let the microtask chain inside check() settle.
async function flush() {
    for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("createUpdateWatch", () => {
    it("prompts once when a newer build is already staged at load, and stops checking", async () => {
        const h = harness([NEWER]);
        h.watch.start();
        await flush(); // the immediate check on start()

        expect(h.prompts).toBe(1);
        // Nothing more to watch for until the restart it just asked for.
        expect(h.cleared).toBe(1);
        expect(h.armed).toBe(false);
    });

    it("stays silent while the staged build matches, then prompts when it changes", async () => {
        const h = harness([RUNNING, RUNNING, NEWER]);
        h.watch.start();
        await flush();
        expect(h.prompts).toBe(0);
        expect(h.armed).toBe(true);

        await h.tick(); // still the running build
        expect(h.prompts).toBe(0);

        await h.tick(); // now a newer build is staged
        expect(h.prompts).toBe(1);
        expect(h.armed).toBe(false);
    });

    it("never prompts more than once", async () => {
        const h = harness([NEWER]);
        h.watch.start();
        await flush();
        // Even if the timer somehow fired again, the prompt is one-shot.
        await h.tick();
        await h.tick();
        expect(h.prompts).toBe(1);
    });

    it("treats a failed disk read as 'nothing new' and keeps watching", async () => {
        const h = harness([new Error("EACCES"), NEWER]);
        h.watch.start();
        await flush();
        expect(h.prompts).toBe(0);
        expect(h.armed).toBe(true); // a rejection did not stop the watch

        await h.tick();
        expect(h.prompts).toBe(1);
    });

    it("stop() disarms the interval", async () => {
        const h = harness([RUNNING]);
        h.watch.start();
        await flush();
        expect(h.armed).toBe(true);

        h.watch.stop();
        expect(h.armed).toBe(false);
        expect(h.cleared).toBe(1);
    });
});
