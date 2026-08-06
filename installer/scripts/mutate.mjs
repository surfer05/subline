/**
 * Mutation harness.
 *
 * Apply one source mutation, run the suite, assert it FAILS, restore.
 *
 * ## The harness is verified before it is trusted
 *
 * This project has been burned by a vacuous harness once already: a bad reporter
 * flag meant the suite was failing to start, so every "catch" was really the
 * runner erroring out, and twenty-five kills were fake. So before any mutation
 * is applied this script:
 *
 *   1. runs the suite UNMUTATED and requires it to pass, and
 *   2. requires the run to report a NON-ZERO test count.
 *
 * A run reporting zero tests is treated as a broken harness and aborts the whole
 * script, never as a kill. Every mutation result below also carries the test
 * count it saw, so a silently-collapsing suite is visible in the output rather
 * than flattering it.
 *
 * A mutation that leaves the suite green is a SURVIVOR: the behaviour it changed
 * is not actually asserted anywhere, and the test that claims to cover it is
 * decorative.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Each mutation: a file, an exact string to find, what to replace it with, and
 * the test whose name should start failing. `expect` is documentation and a
 * cross-check — a mutation killed by a DIFFERENT test than the one claimed is
 * still reported, because that usually means the intended test is vacuous and
 * something else happened to catch it.
 */
const MUTATIONS = [
    /* ---- log.ts ---- */
    {
        name: "log: sensitive keys are not redacted",
        file: "src/app/log.ts",
        find: "    return REDACTED_FIELD_KEYS.some(candidate => candidate.toLowerCase() === lower);",
        with: "    return false;",
        expect: "blanks every key on the sensitive list"
    },
    {
        name: "log: long values are not truncated",
        file: "src/app/log.ts",
        find: "    return flattened.length > MAX_FIELD_CHARS",
        with: "    return false",
        expect: "caps a long value on a key nobody thought to add"
    },
    {
        name: "log: rotates AFTER the overflowing write instead of before",
        file: "src/app/log.ts",
        find: "        if (size + incomingBytes <= this.maxBytes) return;",
        with: "        if (size <= this.maxBytes) return;",
        expect: "rotates before the write that would overflow"
    },
    {
        name: "log: the shared bundle keeps the home directory",
        file: "src/app/log.ts",
        find: "    return text.split(home).join(\"~\");",
        with: "    return text;",
        expect: "replaces the home directory with ~"
    },
    {
        name: "log: newlines are not flattened",
        file: "src/app/log.ts",
        find: "    const flattened = value.replace(/[\\r\\n\\t]+/g, \" \");",
        with: "    const flattened = value;",
        expect: "flattens newlines"
    },

    /* ---- language.ts ---- */
    {
        name: "language: the region qualifier is kept",
        file: "src/app/language.ts",
        find: "    const primary = trimmed.split(/[-_]/)[0] ?? \"\";",
        with: "    const primary = trimmed;",
        expect: "strips the region"
    },
    {
        name: "language: names are shown in English, not in themselves",
        file: "src/app/language.ts",
        find: "        name = new Intl.DisplayNames([code], { type: \"language\" }).of(code);",
        with: "        name = new Intl.DisplayNames([\"en\"], { type: \"language\" }).of(code);",
        expect: "gives the name in the language's own language"
    },
    {
        name: "language: any well-shaped subtag is accepted as a language",
        file: "src/app/language.ts",
        find: "    return bare !== null && endonymOf(bare) !== null;",
        with: "    return bare !== null;",
        expect: "rejects a well-shaped subtag that is not a language"
    },
    {
        name: "language: existing plugin settings are replaced, not merged",
        file: "src/app/language.ts",
        find: "    plugins[PLUGIN_SETTINGS_KEY] = { ...existing, enabled: true, [TARGET_LANG_KEY]: code };",
        with: "    plugins[PLUGIN_SETTINGS_KEY] = { enabled: true, [TARGET_LANG_KEY]: code };",
        expect: "MERGES: an existing Vencord user keeps every other plugin"
    },
    {
        name: "language: a corrupt settings file is overwritten",
        file: "src/app/language.ts",
        find: "            if (typeof parsed !== \"object\" || parsed === null || Array.isArray(parsed)) throw new Error(\"not an object\");",
        with: "            if (false) throw new Error(\"not an object\");",
        expect: "refuses a settings file that parses to an array"
    },
    {
        name: "language: the plugin is not enabled",
        file: "src/app/language.ts",
        find: "enabled: true, [TARGET_LANG_KEY]: code };",
        with: "enabled: false, [TARGET_LANG_KEY]: code };",
        expect: "enables the plugin"
    },

    /* ---- modInstall.ts ---- */
    {
        name: "modInstall: reports the SOURCE bundle instead of the installed copy",
        file: "src/app/modInstall.ts",
        find: "    const installed = inspectModBundle(destDir);",
        with: "    const installed = inspectModBundle(sourceDir);",
        expect: "returns a loaderPath under the runtime directory"
    },
    {
        name: "modInstall: replaces a directory that is not one of ours (guard now lives in removeModBundle)",
        file: "src/bundle/bundle.ts",
        find: "    if (!existsSync(manifestPathFor(bundleDir))) {",
        with: "    if (false) {",
        expect: "refuses to replace a directory that is not one of ours"
    },
    {
        name: "modInstall: allows installing a bundle onto itself",
        file: "src/app/modInstall.ts",
        find: "    if (destDir === sourceDir) {",
        with: "    if (false) {",
        expect: "refuses to 'install' a bundle onto itself"
    },
    {
        name: "modInstall: leaves the staging directory behind on failure",
        file: "src/app/modInstall.ts",
        find: "    const staged = inspectModBundle(staging);\n    if (!staged.ok) {\n        rmSync(staging, { recursive: true, force: true });",
        with: "    const staged = inspectModBundle(staging);\n    if (!staged.ok) {",
        expect: "cleans up the staging directory when the copy is rejected"
    },
    {
        name: "modInstall: does not clear an interrupted run's staging directory",
        file: "src/app/modInstall.ts",
        find: "        rmSync(staging, { recursive: true, force: true });\n        mkdirSync(dirname(destDir), { recursive: true });",
        with: "        mkdirSync(dirname(destDir), { recursive: true });",
        expect: "clears a staging directory left by an interrupted earlier run"
    },

    /* ---- appManagement.ts ---- */
    {
        name: "appManagement: a refused write reads as granted",
        file: "src/app/appManagement.ts",
        find: "        if (errno === \"EPERM\" || errno === \"EACCES\") return \"blocked\";",
        with: "        if (false) return \"blocked\";",
        expect: "reports blocked for the errnos App Management produces"
    },
    {
        name: "appManagement: an unrelated errno reads as blocked",
        file: "src/app/appManagement.ts",
        find: "        return \"unknown\";\n    } finally {",
        with: "        return \"blocked\";\n    } finally {",
        expect: "reports unknown — not blocked — for an unrelated failure"
    },
    {
        name: "appManagement: the probe file is left inside the app bundle",
        file: "src/app/appManagement.ts",
        find: "            rmSync(probePath, { force: true });",
        with: "            void probePath;",
        expect: "removes the probe file"
    },
    {
        name: "appManagement: it probes once and never polls",
        file: "src/app/appManagement.ts",
        find: "    while (status !== \"granted\" && status !== \"not-required\") {",
        with: "    while (false) {",
        expect: "keeps polling and continues automatically"
    },
    {
        name: "appManagement: macOS gating applies on every platform",
        file: "src/app/appManagement.ts",
        find: "    if (platform !== \"darwin\") return \"not-required\";",
        with: "    if (false) return \"not-required\";",
        expect: "reports not-required off macOS"
    },
    {
        name: "appManagement: never escalates to relaunch advice",
        file: "src/app/appManagement.ts",
        find: "        !permitted && attempts >= RELAUNCH_ADVICE_AFTER_ATTEMPTS ? \"relaunch\" : \"grant\";",
        with: "        \"grant\";",
        expect: "advises granting first, and only escalates to relaunch"
    },

    /* ---- discordProcess.ts ---- */
    {
        name: "discordProcess: matches Discord by substring, so helpers count",
        file: "src/app/discordProcess.ts",
        find: "        return (platform === \"win32\" ? name.toLowerCase() : name) === wanted;",
        with: "        return process.command.includes(wanted);",
        expect: "ignores helper processes"
    },
    {
        name: "discordProcess: assumes the quit request worked",
        file: "src/app/discordProcess.ts",
        find: "        const remaining = await isDiscordRunning(options);",
        with: "        const remaining = [];",
        expect: "gives up asking after the grace period"
    },
    {
        name: "discordProcess: reports a still-running Discord as clear",
        file: "src/app/discordProcess.ts",
        find: "                outcome: \"still-running\",\n                clear: false,",
        with: "                outcome: \"still-running\",\n                clear: true,",
        expect: "hands a stubborn Discord back to the user"
    },
    {
        name: "discordProcess: a failed quit request reads as clear",
        file: "src/app/discordProcess.ts",
        find: "            outcome: \"quit-failed\",\n            clear: false,",
        with: "            outcome: \"quit-failed\",\n            clear: true,",
        expect: "reports a named outcome when the quit request itself fails"
    },

    /* ---- flow.ts ---- */
    {
        name: "flow: BetterDiscord is offered as a choice like any other mod",
        file: "src/app/flow.ts",
        find: "            if (installState.mod === \"betterdiscord\") {",
        with: "            if (false) {",
        expect: "refuses, and offers NO way to proceed"
    },
    {
        name: "flow: the BetterDiscord screen gains a proceed button",
        file: "src/app/flow.ts",
        find: "                    actions: [\"recheck\", \"cancel\"]\n                }));",
        with: "                    actions: [\"recheck\", \"proceed-over-mod\", \"cancel\"]\n                }));",
        expect: "refuses, and offers NO way to proceed"
    },
    {
        name: "flow: actions the state did not offer are obeyed anyway",
        file: "src/app/flow.ts",
        find: "        if (!this.current.actions.includes(action.type)) {",
        with: "        if (false) {",
        expect: "ignores an action the current state did not offer"
    },
    {
        name: "flow: permission is attempted rather than explained first",
        file: "src/app/flow.ts",
        find: "        if (status === \"granted\" || status === \"not-required\") return this.applyPatch();",
        with: "        return this.applyPatch(); if (false)",
        expect: "explains BEFORE attempting"
    },
    {
        name: "flow: patches against the shipped bundle, not the installed copy",
        file: "src/app/flow.ts",
        find: "            modBundleDir: installed.value.dir,",
        with: "            modBundleDir: this.ports.inspectShippedBundle().ok ? \"/app/Contents/Resources/mod\" : installed.value.dir,",
        expect: "patches against the RUNTIME bundle directory"
    },
    {
        name: "flow: reaching the last screen counts as success",
        file: "src/app/flow.ts",
        find: "    return state.step === \"done\" && state.verification?.confirmed === true;",
        with: "    return state.step === \"done\";",
        expect: "does NOT claim success when the mod never reported in"
    },
    {
        name: "flow: verification is given a guessed build id",
        file: "src/app/flow.ts",
        find: "            expectedBuildId: patch.pluginBuildId,",
        with: "            expectedBuildId: \"0000000000000000\",",
        expect: "hands verification the build id from the patch it just made"
    },
    {
        name: "flow: a rolled-back patch does not say it rolled back",
        file: "src/app/flow.ts",
        find: "        const rolledBack = error.code === \"VERIFICATION_FAILED\";",
        with: "        const rolledBack = false;",
        expect: "says the rollback happened"
    },
    {
        name: "flow: Discord being open no longer stops the patch",
        file: "src/app/flow.ts",
        find: "        if (running.length > 0) {",
        with: "        if (false) {",
        expect: "offers to quit it rather than patching underneath it"
    },
    {
        name: "flow: the language screen labels languages in English",
        file: "src/app/flow.ts",
        find: "        const endonym = endonymOf(code) ?? code;",
        with: "        const endonym = new Intl.DisplayNames([\"en\"], { type: \"language\" }).of(code) ?? code;",
        expect: "pre-fills from Discord's locale and names it in its own language"
    },
    {
        name: "flow: a failed language save continues to the patch anyway",
        file: "src/app/flow.ts",
        find: "            return this.languageStep(saved.error);",
        with: "            return this.permissionStep();",
        expect: "stays on the language screen with a named error"
    },
    {
        name: "flow: the verification summary is reworded into a success",
        file: "src/app/flow.ts",
        find: "            detail: report.summary,\n            verification: report,",
        with: "            detail: \"All done!\",\n            verification: report,",
        expect: "shows verifyOnce's own sentence, unedited"
    },
    {
        name: "flow: a broken mod bundle is discovered only after patching",
        file: "src/app/flow.ts",
        find: "        if (!bundle.ok) {",
        with: "        if (false) {",
        expect: "is caught before the user is asked for anything"
    },
    {
        name: "flow: recheck from the BetterDiscord screen does nothing",
        file: "src/app/flow.ts",
        find: "            case \"betterdiscord-blocked\":\n                return this.chosenInstall === null ? this.detect() : this.inspectChosen(this.chosenInstall);",
        with: "            case \"betterdiscord-blocked\":\n                return this.current;",
        expect: "moves on once BetterDiscord has actually been removed"
    },
    {
        name: "flow: an empty install list is treated as success",
        file: "src/app/flow.ts",
        find: "        if (!located.ok || located.value.length === 0) {",
        with: "        if (!located.ok) {",
        expect: "treats an empty list as not-found"
    },

    /* ---- uninstall.ts ---- */
    {
        name: "uninstall: removes the mod bundle even with a Discord still patched",
        file: "src/app/uninstall.ts",
        find: "    if (!discordRestored) {",
        with: "    if (false) {",
        expect: "KEEPS the bundle when any Discord is still patched"
    },
    {
        name: "uninstall: deletes Vencord's whole settings file",
        file: "src/app/uninstall.ts",
        find: "    delete table[PLUGIN_SETTINGS_KEY];",
        with: "    for (const key of Object.keys(table)) delete table[key];",
        expect: "removes only our key"
    },
    {
        name: "uninstall: a missing backup gets the generic message",
        file: "src/app/uninstall.ts",
        find: "        const missingBackup = input.problems.some(problem => problem.code === \"BACKUP_MISSING\");",
        with: "        const missingBackup = false;",
        expect: "says plainly what to do when the backup is gone"
    },
    {
        name: "uninstall: settings are removed even when the user kept them",
        file: "src/app/uninstall.ts",
        find: "    if (!keepSettings) {",
        with: "    if (true) {",
        expect: "keeps settings and per-user data by default"
    },
    {
        name: "uninstall: a corrupt settings file is rewritten",
        file: "src/app/uninstall.ts",
        find: "        if (typeof parsed !== \"object\" || parsed === null || Array.isArray(parsed)) {",
        with: "        if (false) {",
        expect: "refuses a settings file that PARSES but is not an object"
    },

    /* ---- main/ports.ts ---- */
    {
        name: "ports: verification reads the beacon from the process default home",
        file: "src/main/ports.ts",
        find: "        verify: verifyOptions => awaitVerification({ ...verifyOptions, platform, env, home })",
        with: "        verify: verifyOptions => awaitVerification(verifyOptions)",
        expect: "finds, patches and verifies a temp-directory Discord"
    },
    {
        name: "ports: Windows quit becomes a forced kill",
        file: "src/main/ports.ts",
        find: "        await exec(\"taskkill\", [\"/IM\", processNameFor(branch, \"win32\")]);",
        with: "        await exec(\"taskkill\", [\"/F\", \"/IM\", processNameFor(branch, \"win32\")]);",
        expect: "never passes /F on Windows"
    },
    {
        name: "ports: the mod is installed from and to the same shipped directory",
        file: "src/main/ports.ts",
        find: "                : installModBundle({ sourceDir: shippedDir, destDir: runtimeDir }),",
        with: "                : installModBundle({ sourceDir: shippedDir, destDir: shippedDir }),",
        expect: "makes Discord require the RUNTIME bundle"
    },
    {
        name: "ports: the search root override is ignored",
        file: "src/main/ports.ts",
        find: "                ...(options.searchRoots === undefined ? {} : { searchRoots: options.searchRoots }),",
        with: "",
        expect: "finds, patches and verifies a temp-directory Discord"
    }
];

/* ------------------------------------------------------------------------ */

function runSuite() {
    const out = join(mkdtempSync(join(tmpdir(), "subline-mut-")), "result.json");
    let failed = false;
    try {
        execFileSync("npx", ["vitest", "run", "--reporter=json", `--outputFile=${out}`], {
            cwd: root,
            stdio: "pipe",
            encoding: "utf8"
        });
    } catch {
        failed = true;
    }

    let report;
    try {
        report = JSON.parse(readFileSync(out, "utf8"));
    } catch {
        return { total: 0, failedTests: 0, failed, broken: true, names: [] };
    } finally {
        rmSync(dirname(out), { recursive: true, force: true });
    }

    const names = [];
    for (const suite of report.testResults ?? []) {
        for (const assertion of suite.assertionResults ?? []) {
            if (assertion.status === "failed") names.push(assertion.title ?? "");
        }
    }
    return {
        total: report.numTotalTests ?? 0,
        failedTests: report.numFailedTests ?? 0,
        failed,
        broken: false,
        names
    };
}

function main() {
    // ---- Step 1: prove the harness is not vacuous ------------------------
    const baseline = runSuite();
    if (baseline.broken || baseline.total === 0) {
        console.error(`HARNESS BROKEN: the unmutated run reported ${baseline.total} tests. Aborting — every "kill" would be fake.`);
        process.exit(2);
    }
    if (baseline.failed || baseline.failedTests > 0) {
        console.error(`HARNESS BROKEN: the unmutated suite is not green (${baseline.failedTests} failing of ${baseline.total}).`);
        process.exit(2);
    }
    console.log(`baseline: ${baseline.total} tests, all passing. Harness reports real counts.\n`);

    // ---- Step 2: mutate --------------------------------------------------
    const survivors = [];
    const wrongTest = [];
    let killed = 0;

    for (const mutation of MUTATIONS) {
        const path = join(root, mutation.file);
        const original = readFileSync(path, "utf8");

        if (!original.includes(mutation.find)) {
            console.error(`NOT APPLIED — ${mutation.name}: the target text is not in ${mutation.file}`);
            survivors.push(`${mutation.name} (target text missing)`);
            continue;
        }

        writeFileSync(path, original.replace(mutation.find, mutation.with), "utf8");
        let result;
        try {
            result = runSuite();
        } finally {
            writeFileSync(path, original, "utf8");
        }

        if (result.broken || result.total === 0) {
            console.error(`HARNESS BROKEN while running "${mutation.name}" (${result.total} tests). Aborting.`);
            process.exit(2);
        }

        const died = result.failedTests > 0;
        const byExpected = result.names.some(name => name.includes(mutation.expect));
        if (died && byExpected) {
            killed += 1;
            console.log(`KILLED   ${mutation.name}  [${result.failedTests}/${result.total} failing]`);
        } else if (died) {
            killed += 1;
            wrongTest.push(`${mutation.name} — killed, but not by "${mutation.expect}"; by: ${result.names.slice(0, 3).join(" | ")}`);
            console.log(`KILLED*  ${mutation.name}  [caught by a different test]`);
        } else {
            survivors.push(mutation.name);
            console.log(`SURVIVED ${mutation.name}  [${result.total} tests, all green]`);
        }
    }

    console.log(`\n${killed}/${MUTATIONS.length} killed, ${survivors.length} survivors.`);
    for (const note of wrongTest) console.log(`  note: ${note}`);
    for (const survivor of survivors) console.log(`  SURVIVOR: ${survivor}`);
    process.exit(survivors.length === 0 ? 0 : 1);
}

main();
