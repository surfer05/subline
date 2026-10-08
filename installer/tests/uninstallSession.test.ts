import { describe, expect, it } from "vitest";

import { refusedReport } from "../src/app/uninstall.js";
import { UninstallSession } from "../src/app/uninstallSession.js";

describe("after a refused uninstall the window is not dead (audit 2026-10-06 #40)", () => {
    it("a DISCORD_RUNNING, NOT_WRITABLE, cancelled or failed-check report hands the flow back", () => {
        for (const report of [
            refusedReport([{ code: "DISCORD_RUNNING", message: "open" }], "open"),
            refusedReport([{ code: "NOT_WRITABLE", message: "no" }], "no"),
            { ...refusedReport([], "Nothing was changed."), cancelled: true },
            { ...refusedReport([{ code: "IO_ERROR", message: "x" }], "x"), permissionCheckFailed: true }
        ]) {
            const session = new UninstallSession();
            session.begin();
            expect(session.mayDriveFlow).toBe(false);
            session.finish(report);
            expect(session.mayDriveFlow).toBe(true);
        }
    });

    it("a report that changed anything keeps the flow stopped", () => {
        const session = new UninstallSession();
        session.begin();
        session.finish({ ...refusedReport([{ code: "FILE_IN_USE", message: "held" }], "partly"), nothingChanged: false });
        expect(session.mayDriveFlow).toBe(false);
    });
});
