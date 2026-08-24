/**
 * The Windows half of spec §6: keep Subline alive across Discord updates.
 *
 * macOS uses a LaunchAgent (`launchAgent.ts`); Windows uses a Scheduled Task.
 * The shape here deliberately mirrors that file — render a definition, register
 * it, then CONFIRM the registration by querying it back — because the failure
 * both mechanisms share is the silent one: a helper that was never really
 * registered looks exactly like a helper that ran and found nothing to do.
 *
 * WHY THIS MATTERS MORE ON WINDOWS. macOS updates Discord in place, so a patch
 * survives until the asar itself is replaced. Windows installs each update into
 * a NEW `app-1.0.xxxx` directory and leaves the old one behind, so the moment
 * Discord updates, our patch is sitting in a folder Discord no longer runs.
 * Translation stops with no error and no marker anywhere — the exact symptom
 * that took three rounds to diagnose when a Discord update removed Vencord.
 *
 * WHY XML RATHER THAN schtasks FLAGS. `/SC HOURLY` cannot express "and also at
 * logon", and `/RI` is not accepted alongside `/SC ONLOGON` on every Windows
 * version. More importantly neither flag form can set `StartWhenAvailable`,
 * which is what runs the repair on a machine that was switched off at the
 * scheduled time — precisely the case where Discord updated while nobody was
 * looking. The XML says all three in one definition.
 */

import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Result } from "../patcher/result.js";
import { err, fsError, ok, rewrap } from "../patcher/result.js";
import { DEFAULT_INTERVAL_SECONDS, HELPER_FLAG } from "./launchAgent.js";

/**
 * The registered task's name.
 *
 * A backslash makes Task Scheduler file it under a `Subline` folder rather than
 * loose in the root with Windows' own tasks, so a user browsing taskschd.msc
 * can see what we added and remove it by hand if they ever want to.
 */
export const HELPER_TASK_NAME = "\\Subline\\Helper";

export interface ScheduledTaskSpec {
    name: string;
    /** The executable to run. Absolute; quoting is the renderer's job, not the caller's. */
    executablePath: string;
    /** Arguments, already split. */
    arguments: readonly string[];
    intervalSeconds: number;
    runAtLogon: boolean;
    /** Author string recorded in the task, so the origin is visible in taskschd.msc. */
    author: string;
}

export function helperScheduledTaskSpec(
    executablePath: string,
    intervalSeconds: number = DEFAULT_INTERVAL_SECONDS,
    name: string = HELPER_TASK_NAME
): ScheduledTaskSpec {
    return {
        name,
        executablePath,
        arguments: [HELPER_FLAG],
        intervalSeconds,
        // The half that repairs a Discord which updated while the machine was off.
        runAtLogon: true,
        author: "Subline"
    };
}

/**
 * XML escaping.
 *
 * The install path is user-controlled — Windows allows `&` in folder names, and
 * NSIS lets the directory be chosen. An unescaped one produces XML that
 * Task Scheduler refuses, and a rejected registration presents as "the helper
 * silently never runs": the exact failure this whole task exists to prevent.
 * `launchAgent.ts` escapes its plist for the same reason.
 */
function xml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

/** `PT1H`, `PT30M` — the ISO 8601 duration Task Scheduler wants for a repetition. */
export function isoDuration(seconds: number): string {
    const whole = Math.max(60, Math.floor(seconds));
    if (whole % 3600 === 0) return `PT${whole / 3600}H`;
    if (whole % 60 === 0) return `PT${whole / 60}M`;
    return `PT${whole}S`;
}

/**
 * Render the task definition.
 *
 * `StartBoundary` is a fixed date in the past on purpose: the trigger only has
 * to be "already active", and generating it from the clock would make the same
 * install produce a different definition every run, which is untestable and
 * makes two machines impossible to compare.
 */
export function renderScheduledTaskXml(spec: ScheduledTaskSpec): string {
    // The hourly repetition rides on the TIME trigger only. A <Repetition>
    // inside <LogonTrigger> is accepted by some Windows builds and rejected by
    // others, and it buys nothing: the time trigger already repeats forever, so
    // the logon trigger's whole job is the single run after a boot.
    const logonTrigger = spec.runAtLogon
        ? `    <LogonTrigger>\n      <Enabled>true</Enabled>\n    </LogonTrigger>\n`
        : "";

    // <Settings> is a SEQUENCE, not a bag: Task Scheduler validates the order
    // and rejects the whole document with nothing but "the task XML is
    // malformed" when it is wrong. Only the settings that earn their place are
    // emitted, in schema order — every one left out has a default we are happy
    // with, and each one included is another chance to get the order wrong.
    return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>${xml(spec.author)}</Author>
    <Description>Keeps Subline working when Discord updates itself.</Description>
  </RegistrationInfo>
  <Triggers>
${logonTrigger}    <TimeTrigger>
      <StartBoundary>2020-01-01T00:00:00</StartBoundary>
      <Enabled>true</Enabled>
      <Repetition>
        <Interval>${isoDuration(spec.intervalSeconds)}</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(spec.executablePath)}</Command>
      <Arguments>${xml(spec.arguments.join(" "))}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

export interface SchtasksPort {
    /** `schtasks /Create /TN <name> /XML <path> /F` */
    create(name: string, xmlPath: string): Promise<Result<true>>;
    /** Flags only, no XML — the fallback. See `createSimple` in ports.ts. */
    createSimple(name: string, command: string): Promise<Result<true>>;
    /** `schtasks /Delete /TN <name> /F` */
    remove(name: string): Promise<Result<true>>;
    /** `schtasks /Query /TN <name>` — is it registered right now? */
    exists(name: string): Promise<boolean>;
}

export interface InstallScheduledTaskOptions {
    spec: ScheduledTaskSpec;
    /** Directory for the temporary XML. Ours, never Discord's. */
    workDir: string;
    schtasks: SchtasksPort;
    platform?: NodeJS.Platform;
}

export interface ScheduledTaskReport {
    name: string;
    /** True when a previous registration was replaced. */
    replaced: boolean;
    registered: boolean;
    /**
     * True when the precise definition was refused and the flags-only fallback
     * was used instead. Recorded rather than hidden: it means the helper runs
     * hourly but not at logon, and does not catch up a missed window.
     */
    simplified?: boolean;
}

/**
 * Write the definition and register it.
 *
 * The XML is written as UTF-16LE WITH A BOM. `schtasks /XML` rejects UTF-8 on
 * several Windows builds with nothing but "The task XML is malformed", and the
 * encoding declaration in the document says UTF-16 — a file whose bytes
 * disagreed with its own header would be a registration that fails only on some
 * machines, which is the worst kind.
 */
export async function installScheduledTask(
    options: InstallScheduledTaskOptions
): Promise<Result<ScheduledTaskReport>> {
    const platform = options.platform ?? process.platform;
    if (platform !== "win32") {
        return err<ScheduledTaskReport>(
            "HELPER_REGISTRATION_FAILED",
            "Scheduled Tasks are a Windows mechanism; macOS uses a LaunchAgent instead."
        );
    }

    const { spec, schtasks, workDir } = options;
    const replaced = await schtasks.exists(spec.name);

    const xmlPath = join(workDir, "subline-helper-task.xml");
    try {
        mkdirSync(workDir, { recursive: true });
        const document = renderScheduledTaskXml(spec);
        writeFileSync(`${xmlPath}.tmp`, Buffer.concat([
            Buffer.from([0xff, 0xfe]),
            Buffer.from(document, "utf16le")
        ]));
        renameSync(`${xmlPath}.tmp`, xmlPath);
    } catch (cause) {
        return fsError<ScheduledTaskReport>(cause, xmlPath, "write the Subline helper's scheduled task");
    }

    const created = await schtasks.create(spec.name, xmlPath);

    // The XML is a hand-off file, not state. Leaving it behind would put a
    // stale definition next to a live task, and the next person to read it
    // would have no way to tell whether it is what is actually registered.
    try {
        rmSync(xmlPath, { force: true });
    } catch {
        // Reporting the registration result matters more than the tidy-up.
    }

    // A rejected document must not mean no helper. Task Scheduler answers an
    // XML it dislikes with nothing more useful than "the task XML is malformed",
    // and the difference between a precise definition and a working one is not
    // worth a user losing self-repair entirely. So: try the definition we want,
    // and if Windows will not take it, register the one it certainly will.
    if (!created.ok) {
        const simple = await schtasks.createSimple(
            spec.name,
            `"${spec.executablePath}" ${spec.arguments.join(" ")}`
        );
        if (simple.ok && await schtasks.exists(spec.name)) {
            return ok({ name: spec.name, replaced, registered: true, simplified: true });
        }
    }

    if (!created.ok) {
        // Re-wrapped WITH the cause. Dropping it here is how a real failure
        // reached a user as "Windows refused to register the Subline helper
        // task" and nothing else — schtasks had said exactly why on stderr, and
        // this line threw it away one level above the port that captured it.
        return rewrap<ScheduledTaskReport>(created.error, {
            code: "HELPER_REGISTRATION_FAILED",
            path: spec.name
        });
    }

    // CONFIRMED, not assumed — the same standard `installLaunchAgent` and the
    // patcher hold their own writes to. schtasks can exit 0 having registered
    // nothing usable.
    const registered = await schtasks.exists(spec.name);
    if (!registered) {
        return err<ScheduledTaskReport>(
            "HELPER_REGISTRATION_FAILED",
            "The Subline helper was registered but Windows does not list the task, so background updates would not run.",
            { path: spec.name }
        );
    }

    return ok({ name: spec.name, replaced, registered, simplified: false });
}

/**
 * Remove the task — §8 step 3.
 *
 * `ok(false)` means there was nothing registered, which is the honest answer for
 * an uninstall run twice. Mirrors `removeLaunchAgent`, including the reason its
 * ordering matters: an uninstalled product whose helper is still scheduled puts
 * Discord straight back at the next interval.
 */
export async function removeScheduledTask(options: {
    name?: string;
    schtasks: SchtasksPort;
    platform?: NodeJS.Platform;
}): Promise<Result<boolean>> {
    const platform = options.platform ?? process.platform;
    if (platform !== "win32") return ok(false);

    const name = options.name ?? HELPER_TASK_NAME;
    if (!await options.schtasks.exists(name)) return ok(false);

    const removed = await options.schtasks.remove(name);
    if (!removed.ok) return removed as Result<boolean>;

    // Verified gone, for the same reason registration is verified present.
    if (await options.schtasks.exists(name)) {
        return err<boolean>(
            "HELPER_REGISTRATION_FAILED",
            "Windows still lists the Subline helper task after it was deleted.",
            { path: name }
        );
    }
    return ok(true);
}
