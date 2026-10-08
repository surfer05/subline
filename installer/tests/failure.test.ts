import { describe, expect, it } from "vitest";

import { guardedFlowCall, UNEXPECTED_FAILURE_COPY, unexpectedFailureState } from "../src/app/failure.js";
import { InstallFlow } from "../src/app/flow.js";
import type { FlowPorts } from "../src/app/flow.js";

describe("a throw inside the flow still leaves a button (audit #20)", () => {
    it("guardedFlowCall turns a throw into the failure state and logs the cause", async () => {
        const crashes: unknown[] = [];
        const state = await guardedFlowCall(() => { throw Object.assign(new Error("ENOSPC: no space left"), { code: "ENOSPC" }); }, c => crashes.push(c));
        expect(state).toMatchObject({ step: "failed", actions: ["finish"], busy: false });
        expect((state as ReturnType<typeof unexpectedFailureState>).error.cause).toContain("ENOSPC");
        expect(crashes).toHaveLength(1);
    });

    it("a value passes through untouched", async () => {
        expect(await guardedFlowCall(async () => 42, () => {})).toBe(42);
    });

    it("a flow whose logger throws inside a transition: the guarded call resolves with Done", async () => {
        let throwNext = false;
        const log = {
            info: () => { if (throwNext) { throwNext = false; throw new Error("EACCES: log folder"); } },
            warn: () => {},
            error: () => {}
        };
        const flow = new InstallFlow({ log, platform: "darwin" } as unknown as FlowPorts);
        throwNext = true;
        const state = await guardedFlowCall(() => flow.send({ type: "next" }), () => {});
        expect(state).toMatchObject({ step: "failed", actions: ["finish"] });
    });

    it("plain sentences, no dashes", () => {
        expect(UNEXPECTED_FAILURE_COPY.detail).not.toMatch(/—|–/);
    });
});
