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
 *
 * ## Equivalent mutants, and the one rule for them
 *
 * A mutation marked `equivalent` is one that provably CANNOT change behaviour,
 * because an invariant somewhere else makes the two forms identical. No test can
 * kill it, and adding a test that appeared to would be a test asserting nothing.
 *
 * They are expected to survive, and surviving is not counted against the run.
 * **A killed one is news**: it means the invariant it rested on has moved, and
 * the code that quietly depended on that invariant now needs re-reading. So the
 * `equivalent` field carries the reason as a string rather than a boolean, and
 * every one has to be argued for in the report — an unexamined `equivalent: "..."`
 * is exactly how a real gap gets marked as not-a-gap and stops being looked at.
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
    },

    /* ==================================================================== *
     * The background helper (spec §6). Two triggers, a health check that
     * must not cry wolf, and a LaunchAgent nothing here ever registers.
     * ==================================================================== */

    {
        name: "settle: never asks whether Discord is running",
        file: "src/helper/settle.ts",
        find: "if (await ports.discordRunning(install)) {",
        with: "if (false) {",
        expect: "refuses to act while Discord is running"
    },
    {
        name: "settle: the quiet window is ignored",
        file: "src/helper/settle.ts",
        find: "if (quietFor === null || quietFor < quietMs) {",
        with: "if (false) {",
        expect: "refuses while files under Resources are still being written"
    },
    {
        name: "settle: decides on ONE observation instead of two",
        file: "src/helper/settle.ts",
        find: "                const second = sample(install, ports);",
        with: "                const second = first;",
        expect: "does NOT settle on a quiet gap between two of the updater's own writes"
    },
    {
        name: "settle: a version change during the confirmation is ignored",
        file: "src/helper/settle.ts",
        find: "if (second.version !== first.version) {",
        with: "if (false) {",
        expect: "does NOT settle on a quiet gap between two of the updater's own writes"
    },
    {
        name: "settle: a file change during the confirmation is ignored",
        file: "src/helper/settle.ts",
        find: "} else if (second.newestMtime !== first.newestMtime) {",
        with: "} else if (false) {",
        expect: "does NOT settle when a file changes during the confirmation delay"
    },
    {
        name: "settle: Discord starting during the confirmation is ignored",
        file: "src/helper/settle.ts",
        find: "} else if (await ports.discordRunning(install)) {",
        with: "} else if (false) {",
        expect: "does NOT settle when Discord starts during the confirmation delay"
    },
    {
        name: "settle: an install nothing can date counts as quiet",
        file: "src/helper/settle.ts",
        find: "if (quietFor === null || quietFor < quietMs) {",
        with: "if (quietFor !== null && quietFor < quietMs) {",
        expect: "refuses to call an install settled when nothing under Resources can be dated"
    },
    {
        name: "settle: the observation budget is off by one, so it overruns maxWaitMs",
        file: "src/helper/settle.ts",
        find: "    const maxAttempts = Math.floor(maxWaitMs / Math.max(1, pollMs)) + 1;",
        with: "    const maxAttempts = Math.floor(maxWaitMs / Math.max(1, pollMs)) + 2;",
        expect: "gives up within its budget"
    },
    {
        name: "settle: a zero poll interval divides by zero and never bounds the loop",
        file: "src/helper/settle.ts",
        find: "    const maxAttempts = Math.floor(maxWaitMs / Math.max(1, pollMs)) + 1;",
        with: "    const maxAttempts = 1;",
        expect: "keeps waiting and settles once the update finishes"
    },
    {
        name: "health: a quiet install counts as suspicious",
        file: "src/helper/health.ts",
        find: "const SUSPICIOUS: readonly VerificationStatus[] = [\"translating-not-rendering\"];",
        with: "const SUSPICIOUS: readonly VerificationStatus[] = [\"translating-not-rendering\", \"loaded-idle\"];",
        expect: "calls a loaded mod with nothing to translate QUIET"
    },
    {
        name: "health: an erroring engine counts as a stale build",
        file: "src/helper/health.ts",
        find: "const SUSPICIOUS: readonly VerificationStatus[] = [\"translating-not-rendering\"];",
        with: "const SUSPICIOUS: readonly VerificationStatus[] = [\"translating-not-rendering\", \"loaded-erroring\"];",
        expect: "reports an erroring engine under its own name and NEVER as broken"
    },
    {
        name: "health: silence counts as evidence",
        file: "src/helper/health.ts",
        find: "const SUSPICIOUS: readonly VerificationStatus[] = [\"translating-not-rendering\"];",
        with: "const SUSPICIOUS: readonly VerificationStatus[] = [\"translating-not-rendering\", \"not-loaded\"];",
        expect: "never escalates when nothing has reported in"
    },
    {
        name: "health: escalates without enough observations",
        file: "src/helper/health.ts",
        find: "const qualifies = observations >= minObservations && sustainedMs >= minWindowMs;",
        with: "const qualifies = sustainedMs >= minWindowMs;",
        expect: "does not escalate on a long window with too few sightings"
    },
    {
        name: "health: escalates without a long enough window",
        file: "src/helper/health.ts",
        find: "const qualifies = observations >= minObservations && sustainedMs >= minWindowMs;",
        with: "const qualifies = observations >= minObservations;",
        expect: "does not escalate on enough sightings that are all too close together"
    },
    {
        name: "health: re-escalates on every run",
        file: "src/helper/health.ts",
        find: "escalated: qualifies && !wasBroken,",
        with: "escalated: qualifies,",
        expect: "escalates only ONCE"
    },
    {
        name: "health: suspicion survives a healthy or quiet observation",
        file: "src/helper/health.ts",
        find: "                suspectSince: null,\n                observations: 0",
        with: "                suspectSince: previous.suspectSince,\n                observations: previous.observations",
        expect: "clears the suspicion on a QUIET observation too"
    },
    {
        name: "release: the digest is not compared",
        file: "src/helper/release.ts",
        find: "if (digest !== manifest.artifact.sha256) {",
        with: "if (false) {",
        expect: "refuses bytes of the right length whose digest differs"
    },
    {
        name: "release: the byte count is not compared",
        file: "src/helper/release.ts",
        find: "if (bytes.byteLength !== manifest.artifact.bytes) {",
        with: "if (false) {",
        expect: "names the byte counts when a download arrives short"
    },
    {
        name: "release: plain http is fetched",
        file: "src/helper/release.ts",
        find: "if (parsed.protocol !== \"https:\") {",
        with: "if (false) {",
        expect: "refuses plain http even on an allowed host"
    },
    {
        name: "release: any host is fetched from",
        file: "src/helper/release.ts",
        find: "if (!ALLOWED_RELEASE_HOSTS.includes(parsed.hostname)) {",
        with: "if (false) {",
        expect: "refuses https on a host that is not ours"
    },
    {
        name: "release: an artefact with no checksum is accepted",
        file: "src/helper/release.ts",
        find: "if (typeof artifact.sha256 !== \"string\" || !SHA256_PATTERN.test(artifact.sha256)) {",
        with: "if (false) {",
        expect: "refuses an artefact with no checksum"
    },
    {
        name: "release: an empty verifier list passes everything",
        file: "src/helper/release.ts",
        find: "if (verifiers.length === 0) {",
        with: "if (false) {",
        expect: "refuses an empty verifier list"
    },
    {
        name: "release: verification becomes any-of instead of all-of",
        file: "src/helper/release.ts",
        find: "if (!result.ok) return result as Result<VerifiedRelease>;",
        with: "if (!result.ok) continue;",
        expect: "requires EVERY verifier to pass"
    },
    {
        name: "release: a malformed build id is accepted",
        file: "src/helper/release.ts",
        find: "if (typeof parsed.buildId !== \"string\" || !BUILD_ID_PATTERN.test(parsed.buildId)) {",
        with: "if (typeof parsed.buildId !== \"string\") {",
        expect: "refuses a build id that could never match a bundle's"
    },
    {
        name: "release: any manifest format is understood",
        file: "src/helper/release.ts",
        find: "if (parsed.format !== RELEASE_MANIFEST_FORMAT) {",
        with: "if (false) {",
        expect: "refuses a format it does not understand"
    },
    {
        name: "release: a rolled-back release is never applied",
        file: "src/helper/release.ts",
        find: "return manifest.buildId !== installedBuildId;",
        with: "return installedBuildId !== null && manifest.buildId > installedBuildId;",
        expect: "treats any different build id as something to install"
    },
    {
        name: "launchAgent: the plist is not XML-escaped",
        file: "src/helper/launchAgent.ts",
        find: "        .replace(/&/g, \"&amp;\")",
        with: "        .replace(/&/g, \"&\")",
        expect: "escapes a path launchd would otherwise refuse to parse"
    },
    {
        name: "launchAgent: a live agent is not unregistered before its plist is rewritten",
        file: "src/helper/launchAgent.ts",
        find: "    const replaced = await launchctl.isLoaded(spec.label, uid);\n    if (replaced) {",
        with: "    const replaced = await launchctl.isLoaded(spec.label, uid);\n    if (false) {",
        expect: "unregisters an existing agent BEFORE rewriting its plist"
    },
    {
        name: "launchAgent: a plist is left behind after a failed registration",
        file: "src/helper/launchAgent.ts",
        find: "            rmSync(plistPath, { force: true });\n        } catch {\n            // Reporting the registration failure matters more than the tidy-up.",
        with: "            void plistPath;\n        } catch {\n            // Reporting the registration failure matters more than the tidy-up.",
        expect: "leaves no plist behind when registration fails"
    },
    {
        name: "launchAgent: registration is assumed rather than confirmed",
        file: "src/helper/launchAgent.ts",
        find: "    const loaded = await launchctl.isLoaded(spec.label, uid);\n    if (!loaded) {",
        with: "    const loaded = true;\n    if (!loaded) {",
        expect: "CONFIRMS the registration instead of trusting launchctl"
    },
    {
        name: "launchAgent: the plist is deleted even when the agent could not be stopped",
        file: "src/helper/launchAgent.ts",
        find: "        if (!booted.ok) {\n            return err<boolean>(",
        with: "        if (false) {\n            return err<boolean>(",
        expect: "KEEPS the plist when unregistering fails"
    },
    {
        name: "launchAgent: it never runs at login",
        file: "src/helper/launchAgent.ts",
        find: "        runAtLoad: true",
        with: "        runAtLoad: false",
        expect: "runs at login AND periodically"
    },
    {
        name: "launchAgent: a zero interval is emitted, which launchd reads as unbounded",
        file: "src/helper/launchAgent.ts",
        find: "<integer>${Math.max(1, Math.trunc(spec.intervalSeconds))}</integer>",
        with: "<integer>${Math.trunc(spec.intervalSeconds)}</integer>",
        expect: "never emits a zero or negative interval"
    },
    {
        name: "launchAgent: the agent runs a separate binary instead of the app",
        file: "src/helper/launchAgent.ts",
        find: "return [join(appPath, \"Contents\", \"MacOS\", executableName), HELPER_FLAG];",
        with: "return [join(appPath, \"..\", \"subline-helper\"), HELPER_FLAG];",
        expect: "runs THE APP with a flag, not a separate binary"
    },
    {
        name: "helper: patches without waiting for the updater to settle",
        file: "src/helper/helper.ts",
        find: "    if (!settled.settled) {",
        with: "    if (false) {",
        expect: "defers while Discord is running rather than patching underneath it"
    },
    {
        name: "helper: silently patches over another client mod",
        file: "src/helper/helper.ts",
        find: "        if (state.kind === \"patched-by-other\") {",
        with: "        if (false) {",
        expect: "refuses to patch over another client mod that arrived after us"
    },
    {
        name: "helper: forgets an install the moment its marker is gone",
        file: "src/helper/helper.ts",
        find: "        const oursOnce = remembered !== undefined;",
        with: "        const oursOnce = false;",
        expect: "knows an install is ours from its own memory once the marker is gone"
    },
    {
        name: "helper: acts on a Discord it has never patched",
        file: "src/helper/helper.ts",
        find: "        if (!oursNow && !oursOnce) {",
        with: "        if (false) {",
        expect: "ignores a Discord Subline has never patched"
    },
    {
        name: "helper: the downloaded bundle's identity is not checked against the release",
        file: "src/helper/helper.ts",
        find: "        if (inspected.value.buildId !== manifest.buildId) {",
        with: "        if (false) {",
        expect: "installs nothing when the archive's bundle is not the build the release claimed"
    },
    {
        name: "helper: every update failure is treated as never-transient",
        file: "src/helper/helper.ts",
        find: "    const immediate = error.code === \"RELEASE_UNVERIFIED\";",
        with: "    const immediate = true;",
        expect: "does not cry wolf about a network that is merely down"
    },
    {
        name: "helper: a new build is installed but nothing is re-patched",
        file: "src/helper/helper.ts",
        find: "        const refreshed = refresh(run, entry);",
        with: "        const refreshed = null;",
        expect: "downloads, verifies, installs and re-patches"
    },
    {
        name: "helper: a broken mod does not override the update throttle",
        file: "src/helper/helper.ts",
        find: "        || wasBroken",
        with: "        || false",
        expect: "checks anyway, throttle or not, once health says the mod is broken"
    },
    {
        name: "helper: warns the mod is stale even when a newer build exists",
        file: "src/helper/helper.ts",
        find: "    if (feedHasNewer) {",
        with: "    if (false) {",
        expect: "does NOT warn about a stale mod when a newer build exists"
    },
    {
        name: "helper: health is judged against the marker read BEFORE re-patching",
        file: "src/helper/helper.ts",
        find: "            const marker = run.ports.readMarker(entry.install.resourcesPath);\n            return { ...entry, marker: marker.ok ? marker.value : null };",
        with: "            return entry;",
        expect: "forgets its suspicion when a new build lands"
    },
    {
        name: "helper: a failed re-patch is logged and never surfaced",
        file: "src/helper/helper.ts",
        find: "    if (IMMEDIATE_PATCH_ALERTS.includes(error.code) || failures >= REPATCH_FAILURES_BEFORE_ALERT) {",
        with: "    if (false) {",
        expect: "leaves Discord usable, says the rollback happened, and tells the user"
    },
    {
        name: "helper: an alert is never cleared once the problem is fixed",
        file: "src/helper/helper.ts",
        find: "        run.clear(\"repatch-failed\");",
        with: "        void 0;",
        expect: "clears the alert once a later run succeeds"
    },
    {
        name: "helper: Discord is not re-inspected after a failed patch",
        file: "src/helper/helper.ts",
        find: "    const after = run.ports.inspect(install);\n    const startable = after.ok && after.value.kind !== \"broken\";",
        with: "    const after = run.ports.inspect(install);\n    const startable = true;",
        expect: "names the missing backup rather than giving the generic failure"
    },
    {
        name: "helper: the broken reason is never read, so a missing backup gets the generic message",
        file: "src/helper/helper.ts",
        find: "    if (brokenReason !== null && BACKUP_GONE_REASONS.includes(brokenReason)) {",
        with: "    if (false) {",
        expect: "names the missing backup rather than giving the generic failure"
    },
    {
        name: "helper: a rollback failure gets the ordinary alert",
        file: "src/helper/helper.ts",
        find: "    if (error.code === \"ROLLBACK_FAILED\") {",
        with: "    if (false) {",
        expect: "raises the LOUD alert when the rollback itself failed"
    },
    {
        name: "helper: the failure counter never increments, so one bad night alerts",
        file: "src/helper/helper.ts",
        find: "    const failures = (previous?.failures ?? 0) + 1;",
        with: "    const failures = 2;",
        expect: "gives an ordinary failure a second chance"
    },
    {
        name: "helper: an unusable bundle no longer forces an update check",
        file: "src/helper/helper.ts",
        find: "        || bundleUnusable;",
        with: "        || false;",
        expect: "checks anyway, throttle or not, when the installed bundle is unusable"
    },
    {
        name: "helper: the mod-stale alert survives the update that fixes it",
        file: "src/helper/helper.ts",
        find: "    run.clear(\"mod-stale\");\n\n    // A new bundle behind an unchanged loader path",
        with: "    void 0;\n\n    // A new bundle behind an unchanged loader path",
        expect: "clears the 'needs an update' alert once the update lands"
    },
    {
        name: "alerts: the same alert notifies on every single run",
        file: "src/helper/alerts.ts",
        find: "    const dueAgain = previous === undefined || alert.at - previous.lastNotifiedAt >= repeatMs;",
        with: "    const dueAgain = true;",
        expect: "does not notify again inside the repeat window"
    },
    {
        name: "alerts: a suppressed notification also suppresses the durable record",
        file: "src/helper/alerts.ts",
        find: "    writePendingAlerts(state, ports);\n\n    if (!dueAgain) {",
        with: "    if (dueAgain) writePendingAlerts(state, ports);\n\n    if (!dueAgain) {",
        expect: "keeps the durable record even when the notification is suppressed"
    },
    {
        name: "alerts: a resolved alert leaves its file behind",
        file: "src/helper/alerts.ts",
        find: "            if (existsSync(path)) rmSync(path, { force: true });",
        with: "            if (false) rmSync(path, { force: true });",
        expect: "removes the file entirely when nothing is outstanding"
    },
    {
        name: "helper state: a document that is not an object is read as state",
        file: "src/helper/state.ts",
        find: "    if (!isRecord(parsed)) return emptyHelperState();",
        with: "    if (false) return emptyHelperState();",
        expect: "reads a file that PARSES but is not an object"
    },
    {
        name: "helper state: an alert with no timestamps is kept",
        file: "src/helper/state.ts",
        find: "            if (firstAt === null || lastNotifiedAt === null) continue;",
        with: "            if (false) continue;",
        expect: "keeps the fields it understands when the rest of the document is nonsense"
    },
    {
        name: "uninstall: proceeds even though the helper is still running",
        file: "src/app/uninstall.ts",
        find: "    const helperStopped = !options.helper.applicable || options.helper.error === null;",
        with: "    const helperStopped = true;",
        expect: "changes NOTHING when the helper could not be stopped"
    }
,

    /* ---------------------------------------------------------------- *
     * PACKAGING — written adversarially.
     *
     * helper.md's lesson: "a clean pass means the mutations were not
     * adversarial enough, and the way to find out is to write the ones you
     * expect to survive." Every probe below was written aiming at code
     * suspected of being unasserted, not at code known to be covered.
     * ---------------------------------------------------------------- */

    /* ---- packaging/bundleIdentity.ts ---- */
    {
        name: "bundleIdentity: a stale bundle is shipped anyway",
        file: "packaging/bundleIdentity.ts",
        find: "    if (buildId !== expectedBuildId) {",
        with: "    if (false) {",
        expect: "REFUSES a stale bundle"
    },
    {
        name: "bundleIdentity: the inspector's own problems are discarded",
        file: "packaging/bundleIdentity.ts",
        find: "    const problems: string[] = [...facts.problems];",
        with: "    const problems: string[] = [];",
        expect: "renderer does not carry the id its manifest claims"
    },
    {
        name: "bundleIdentity: a disagreeing plugin version is ignored",
        file: "packaging/bundleIdentity.ts",
        find: "    if (expectedPluginVersion !== null && pluginVersion !== expectedPluginVersion) {",
        with: "    if (false) {",
        expect: "plugin version that disagrees"
    },
    {
        name: "bundleIdentity: everything agrees regardless of the problems found",
        find: "agrees: problems.length === 0, problems };",
        file: "packaging/bundleIdentity.ts",
        with: "agrees: true, problems };",
        expect: "REFUSES a stale bundle"
    },
    {
        name: "bundleIdentity: an inspector that throws reads as a pass",
        file: "packaging/bundleIdentity.ts",
        find: "            agrees: false,\n            problems: [`the mod bundle at ${bundleDir} could not be inspected",
        with: "            agrees: true,\n            problems: [`the mod bundle at ${bundleDir} could not be inspected",
        expect: "inspector that throws"
    },
    {
        name: "bundleIdentity: assert returns instead of throwing, so the hook ignores it",
        file: "packaging/bundleIdentity.ts",
        find: "    if (!report.agrees) {",
        with: "    if (false) {",
        expect: "THROWS on disagreement"
    },
    {
        name: "bundleIdentity: the packaged path forgets the .app wrapper",
        file: "packaging/bundleIdentity.ts",
        find: "        ? [options.appOutDir, `${options.productName}.app`, \"Contents\", \"Resources\"]",
        with: "        ? [options.appOutDir, \"Contents\", \"Resources\"]",
        expect: "Contents/Resources/mod on macOS"
    },
    {
        name: "bundleIdentity: Windows and macOS get the same layout",
        file: "packaging/bundleIdentity.ts",
        find: "        : [options.appOutDir, \"resources\"];",
        with: "        : [options.appOutDir, \"Contents\", \"Resources\"];",
        expect: "resources/mod on Windows"
    },

    /* ---- packaging/manifest.ts ---- */
    {
        name: "manifest: any two slash-separated words are a repository",
        file: "packaging/manifest.ts",
        find: "    const match = /^(?:https:\\/\\/github\\.com\\/|git@github\\.com:)?([^/\\s]+)\\/([^/\\s]+)$/.exec(trimmed);",
        with: "    const match = /^(.+)\\/(.+)$/.exec(trimmed);",
        expect: "not a repository"
    },
    {
        name: "manifest: the feed URL points at a tag instead of latest",
        file: "packaging/manifest.ts",
        find: "/releases/latest/download/${RELEASE_MANIFEST_ASSET_NAME}`;",
        with: "/releases/download/${RELEASE_MANIFEST_ASSET_NAME}`;",
        expect: "untagged feed URL"
    },
    {
        name: "manifest: the version is not tagged",
        file: "packaging/manifest.ts",
        find: "    return version.startsWith(\"v\") ? version : `v${version}`;",
        with: "    return version;",
        expect: "tags a version once"
    },
    {
        name: "manifest: an empty artefact is described rather than refused",
        file: "packaging/manifest.ts",
        find: "    if (artifact.bytes <= 0) {",
        with: "    if (false) {",
        expect: "refuses to describe an empty artefact"
    },
    {
        name: "manifest: the byte count is asserted rather than measured",
        file: "packaging/manifest.ts",
        find: "    return { name: basename(path), bytes: statSync(path).size, sha256: sha256OfFile(path) };",
        with: "    return { name: basename(path), bytes: 1, sha256: sha256OfFile(path) };",
        expect: "real byte count and digest"
    },
    {
        name: "manifest: the checksum file carries paths, not names",
        file: "packaging/manifest.ts",
        find: "    return { name: basename(path), bytes: statSync(path).size, sha256: sha256OfFile(path) };",
        with: "    return { name: path, bytes: statSync(path).size, sha256: sha256OfFile(path) };",
        expect: "names and never paths"
    },
    {
        name: "manifest: SHA256SUMS uses one space, which shasum -c cannot read",
        file: "packaging/manifest.ts",
        find: "        .map(digest => `${digest.sha256}  ${digest.name}`)",
        with: "        .map(digest => `${digest.sha256} ${digest.name}`)",
        expect: "verifiable by the real shasum"
    },
    {
        name: "manifest: checksums are left in whatever order they arrived",
        file: "packaging/manifest.ts",
        find: "        .sort((a, b) => a.name.localeCompare(b.name))",
        with: "        .sort(() => 0)",
        expect: "names and never paths"
    },
    {
        name: "manifest: a release with no artefacts writes an empty checksum file",
        file: "packaging/manifest.ts",
        find: "    if (digests.length === 0) throw new Error(\"A release with no artefacts has nothing to checksum.\");",
        with: "    if (false) throw new Error(\"A release with no artefacts has nothing to checksum.\");",
        expect: "refuses to write a checksum file for nothing"
    },
    {
        name: "manifest: writes a format the shipped reader does not understand",
        file: "packaging/manifest.ts",
        find: "export const RELEASE_MANIFEST_FORMAT_WRITTEN = 1;",
        with: "export const RELEASE_MANIFEST_FORMAT_WRITTEN = 2;",
        expect: "accepted by the reader that SHIPS"
    },
    {
        name: "manifest: the feed asset is renamed, so shipped builds poll a 404",
        file: "packaging/manifest.ts",
        find: "export const RELEASE_MANIFEST_ASSET_NAME = \"subline-release.json\";",
        with: "export const RELEASE_MANIFEST_ASSET_NAME = \"release.json\";",
        expect: "PROVES the URL the release script publishes to"
    },
    {
        name: "manifest: a supplied signature is dropped",
        file: "packaging/manifest.ts",
        find: "        signature: options.signature ?? null",
        with: "        signature: null",
        expect: "carries a signature through"
    },

    /* ---- packaging/notarize.ts ---- */
    {
        name: "notarize: every build notarizes, credentials or not",
        file: "packaging/notarize.ts",
        find: "    return value === \"1\" || value === \"true\";",
        with: "    return true;",
        expect: "only notarizes when the flag is exactly on"
    },
    {
        name: "notarize: a local build submits to Apple anyway",
        file: "packaging/notarize.ts",
        find: "    if (!isNotarizationRequested(env)) {",
        with: "    if (false) {",
        expect: "does nothing at all on a local build"
    },
    {
        name: "notarize: a missing credential is skipped rather than refused",
        file: "packaging/notarize.ts",
        find: "    if (auth === null) {\n        throw new Error(",
        with: "    if (false) {\n        throw new Error(",
        expect: "REFUSES when it was asked to notarize"
    },
    {
        name: "notarize: submits without --wait, so the staple races the ticket",
        file: "packaging/notarize.ts",
        find: "    return [\"notarytool\", \"submit\", archivePath, \"--wait\", ...authArgs(auth)];",
        with: "    return [\"notarytool\", \"submit\", archivePath, ...authArgs(auth)];",
        expect: "always waits"
    },
    {
        name: "notarize: staples the archive instead of the app",
        file: "packaging/notarize.ts",
        find: "    await exec(\"/usr/bin/xcrun\", stapleArgs(path));",
        with: "    await exec(\"/usr/bin/xcrun\", stapleArgs(archivePath));",
        expect: "archives a .app first"
    },
    {
        name: "notarize: submits a .app bundle directly, which notarytool refuses",
        file: "packaging/notarize.ts",
        find: "    const isApp = path.endsWith(\".app\");",
        with: "    const isApp = false;",
        expect: "archives a .app first"
    },
    {
        name: "notarize: the submission archive is left behind on failure",
        file: "packaging/notarize.ts",
        find: "        if (isApp) (options.cleanup ?? (() => {}))(archivePath);",
        with: "        if (false) (options.cleanup ?? (() => {}))(archivePath);",
        expect: "removes the submission archive even when the submission failed"
    },
    {
        name: "notarize: a blank variable counts as a credential",
        file: "packaging/notarize.ts",
        find: "    return typeof value === \"string\" && value.trim().length > 0;",
        with: "    return typeof value === \"string\" && value.length > 0;",
        expect: "treats a blank variable as absent"
    },
    {
        name: "notarize: a half-set Apple ID triple counts as a credential",
        file: "packaging/notarize.ts",
        find: "    if (APPLE_ID_VARS.every(name => present(env, name))) {",
        with: "    if (APPLE_ID_VARS.some(name => present(env, name))) {",
        expect: "treats a blank variable as absent"
    },
    {
        name: "notarize: the leakiest credential form is preferred",
        file: "packaging/notarize.ts",
        find: "    if (present(env, KEYCHAIN_PROFILE_VAR)) {",
        with: "    if (false) {",
        expect: "prefers the credential form that leaks least"
    },

    /* ---- src/helper/feed.ts ---- */
    {
        name: "feed: the update feed is live before any release exists",
        file: "src/helper/feed.ts",
        find: "export const RELEASE_FEED_ENABLED = false;",
        with: "export const RELEASE_FEED_ENABLED = true;",
        expect: "keeps the feed off until there is something to fetch"
    },
    {
        name: "feed: the switch does nothing",
        file: "src/helper/feed.ts",
        find: "    return (options.enabled ?? RELEASE_FEED_ENABLED) ? RELEASE_FEED_URL : null;",
        with: "    return RELEASE_FEED_URL;",
        expect: "keeps the feed off until there is something to fetch"
    },
    {
        name: "feed: releases are published to a repository that is not ours",
        file: "src/helper/feed.ts",
        find: "export const RELEASE_REPOSITORY = \"surfer05/vctranslate\";",
        with: "export const RELEASE_REPOSITORY = \"surfer05/subline\";",
        expect: "repository this code is actually in"
    },

    /* ---- src/app/flow.ts — §3 step 8b ---- */
    {
        name: "flow: the helper is never installed (helper.md concern 8, reopened)",
        file: "src/app/flow.ts",
        find: "        return this.installHelper();\n    }\n\n    /* ----",
        with: "        return this.launch();\n    }\n\n    /* ----",
        expect: "registers it once, between patching and launching"
    },
    {
        name: "flow: retrying the helper re-patches Discord",
        file: "src/app/flow.ts",
        find: "                if (action.type === \"skip-helper\") return this.launch();\n                return this.installHelper();",
        with: "                if (action.type === \"skip-helper\") return this.launch();\n                return this.applyPatch();",
        expect: "re-runs ONLY the helper"
    },
    {
        name: "flow: skipping the helper retries it instead of carrying on",
        file: "src/app/flow.ts",
        find: "                if (action.type === \"skip-helper\") return this.launch();",
        with: "                if (action.type === \"skip-helper\") return this.installHelper();",
        expect: "lets the user finish without it"
    },
    {
        name: "flow: a failed helper is a dead end with no way past it",
        file: "src/app/flow.ts",
        find: "                actions: [\"retry\", \"skip-helper\", \"cancel\"]",
        with: "                actions: [\"retry\", \"cancel\"]",
        expect: "re-runs ONLY the helper"
    },
    {
        name: "flow: the helper's outcome never reaches the last screen",
        file: "src/app/flow.ts",
        find: "            helper: this.helperOutcome ?? undefined,",
        with: "            helper: undefined,",
        expect: "carries the outcome to the last screen"
    },
    {
        name: "flow: a failed helper registration launches Discord anyway",
        file: "src/app/flow.ts",
        find: "                step: \"helper-failed\",",
        with: "                step: \"launching\",",
        expect: "stops on a named screen when registration fails"
    },

    /* ---- src/main/ports.ts ---- */
    {
        name: "ports: Windows is told its helper failed to install",
        file: "src/main/ports.ts",
        find: "    if (platform !== \"darwin\") {\n        return ok({ applicable: false, installed: false, label: null, path: null });",
        with: "    if (false) {\n        return ok({ applicable: false, installed: false, label: null, path: null });",
        expect: "on Windows rather than failing"
    },
    {
        name: "ports: removal on Windows pretends there was an agent",
        file: "src/main/ports.ts",
        find: "    if (platform !== \"darwin\") return { applicable: false, removed: false, error: null };",
        with: "    if (false) return { applicable: false, removed: false, error: null };",
        expect: "on Windows, which uninstall reads as"
    },
    {
        name: "ports: removed reports the call succeeded, not that anything went",
        file: "src/main/ports.ts",
        find: "        removed: removed.ok && removed.value,",
        with: "        removed: removed.ok,",
        expect: "honest when there was nothing to remove"
    },
    {
        name: "ports: a failed bootout is swallowed, so uninstall proceeds",
        file: "src/main/ports.ts",
        find: "        error: removed.ok ? null : removed.error",
        with: "        error: null",
        expect: "ABORTS with nothing changed"
    },
    {
        name: "ports: installed is asserted rather than read back from launchctl",
        file: "src/main/ports.ts",
        find: "        installed: registered.value.loaded,",
        with: "        installed: true,",
        expect: "writes the plist under the given home",
        // `installLaunchAgent` calls `launchctl print` after the bootstrap and
        // RETURNS AN ERROR when the label is not listed, so `loaded` is `true`
        // on every path that reaches here. The two forms are identical, and the
        // one on the left is kept because it propagates an observation rather
        // than restating a conclusion drawn in another file.
        //
        // If this ever gets KILLED, `installLaunchAgent` has stopped confirming
        // its own registration — which is the failure launchAgent.ts's "a
        // registration that silently did not happen is indistinguishable later
        // from a helper with nothing to do" is entirely about.
        equivalent: "installLaunchAgent refuses any registration launchctl does not confirm, so loaded is always true here"
    },

    /* ---- electron-builder.js ---- */
    {
        name: "packaging: signing is on by default, so a build reaches the keychain",
        file: "electron-builder.js",
        find: "const SIGNING_REQUESTED = process.env.SUBLINE_SIGN === \"1\" || process.env.SUBLINE_SIGN === \"true\";",
        with: "const SIGNING_REQUESTED = true;",
        expect: "DOES NOT SIGN unless it was asked to"
    },
    {
        name: "packaging: identity auto-discovery is left on",
        file: "electron-builder.js",
        find: "if (!SIGNING_REQUESTED) process.env.CSC_IDENTITY_AUTO_DISCOVERY = \"false\";",
        with: "if (false) process.env.CSC_IDENTITY_AUTO_DISCOVERY = \"false\";",
        expect: "DOES NOT SIGN unless it was asked to"
    },
    {
        name: "packaging: the hardened runtime is off",
        file: "electron-builder.js",
        find: "        hardenedRuntime: true,",
        with: "        hardenedRuntime: false,",
        expect: "turns the hardened runtime ON"
    },
    {
        name: "packaging: the mod bundle is not shipped at all",
        file: "electron-builder.js",
        find: "    extraResources: [{ from: \"build/mod\", to: \"mod\" }],",
        with: "    extraResources: [],",
        expect: "ships the mod bundle from the directory build:mod writes"
    },
    {
        name: "packaging: the NSIS installer demands administrator rights",
        file: "electron-builder.js",
        find: "        allowElevation: false,",
        with: "        allowElevation: true,",
        expect: "never asks for elevation"
    },
    {
        name: "packaging: the executable is named something launchd cannot find",
        file: "electron-builder.js",
        find: "    productName: \"Subline\",",
        with: "    productName: \"Subline Installer\",",
        expect: "names an executable the LaunchAgent's ProgramArguments will actually find"
    },

    /* ---- patcher/asar.ts: the READER ----
     *
     * The reader used to be tested only against archives buildAsar produced,
     * so writer and reader could share a wrong assumption and agree. These
     * mutations are aimed at the reader alone, and are killed by the
     * literal-byte fixtures in tests/fixture.ts (realVencordStubBytes,
     * foreignOriginalAsarBytes) rather than by anything round-tripped.
     */
    {
        name: "asar: data begins 16 bytes after the header pickle, not 8",
        file: "src/patcher/asar.ts",
        find: "dataOffset: 8 + headerPickleLength",
        with: "dataOffset: 16 + headerPickleLength",
        expect: "reads the real Vencord stub's directory without going through buildAsar"
    },
    {
        name: "asar: data offset measured from the payload rather than the pickle",
        file: "src/patcher/asar.ts",
        find: "dataOffset: 8 + headerPickleLength",
        with: "dataOffset: 8 + headerPayloadLength",
        expect: "reads the real Vencord stub's directory without going through buildAsar"
    },
    {
        name: "asar: header JSON length read from the payload word",
        file: "src/patcher/asar.ts",
        find: "const jsonLength = prefix.readUInt32LE(12);",
        with: "const jsonLength = prefix.readUInt32LE(8);",
        expect: "reads the real Vencord stub's directory without going through buildAsar"
    },
    {
        name: "asar: header JSON read from the wrong file position",
        file: "src/patcher/asar.ts",
        find: "readSync(fd, jsonBuf, 0, jsonLength, 16)",
        with: "readSync(fd, jsonBuf, 0, jsonLength, 20)",
        expect: "reads the real Vencord stub's directory without going through buildAsar"
    },
    {
        name: "asar: header padding rule dropped",
        file: "src/patcher/asar.ts",
        find: "    return rem === 0 ? n : n + (PICKLE_ALIGNMENT - rem);",
        with: "    return n;",
        expect: "reads a foreign archive with padding, nested dirs, integrity, unpacked and link entries"
    },
    {
        name: "asar: already-aligned lengths padded anyway",
        file: "src/patcher/asar.ts",
        find: "    return rem === 0 ? n : n + (PICKLE_ALIGNMENT - rem);",
        with: "    return n + (PICKLE_ALIGNMENT - rem);",
        expect: "reads the real Vencord stub's directory without going through buildAsar"
    },
    {
        name: "asar: entries with a non-string offset treated as files",
        file: "src/patcher/asar.ts",
        find: 'if (typeof size !== "number" || typeof offset !== "string") continue; // a directory or link',
        with: 'if (typeof size !== "number") continue; // a directory or link',
        expect: "ignores entries whose size or offset are the wrong type"
    },
    {
        name: "asar: entries with a non-number size treated as files",
        file: "src/patcher/asar.ts",
        find: 'if (typeof size !== "number" || typeof offset !== "string") continue; // a directory or link',
        with: 'if (typeof offset !== "string") continue; // a directory or link',
        expect: "ignores entries whose size or offset are the wrong type"
    },
    {
        name: "asar: directory names dropped from the entry list",
        file: "src/patcher/asar.ts",
        find: "return ok({ names, files, dataOffset: 8 + headerPickleLength, headerJson });",
        with: "return ok({ names: files.map(f => f.name), files, dataOffset: 8 + headerPickleLength, headerJson });",
        expect: "reads a foreign archive with padding, nested dirs, integrity, unpacked and link entries"
    },
    {
        name: "asar: the size-pickle gate never fires",
        file: "src/patcher/asar.ts",
        find: "if (sizePickleLength !== 4) {",
        with: "if (false) {",
        expect: "rejects a bad size pickle even when every other word is consistent"
    },
    {
        name: "asar: the implausible-header-length gate never fires",
        file: "src/patcher/asar.ts",
        find: "if (jsonLength === 0 || jsonLength > MAX_HEADER_BYTES) {",
        with: "if (false) {",
        expect: "rejects an implausibly large declared header rather than allocating it"
    },
    {
        name: "asar: the too-small-to-be-an-asar gate never fires",
        file: "src/patcher/asar.ts",
        find: "if (readPrefix < 16) {",
        with: "if (false) {",
        expect: "rejects a file too small to hold a prefix, by that name"
    },
    {
        name: "asar: the truncated-header gate never fires",
        file: "src/patcher/asar.ts",
        find: "if (readJson < jsonLength) {",
        with: "if (false) {",
        expect: "rejects a truncated header, by that name"
    },
    {
        name: "asar: the missing-file-table gate never fires",
        file: "src/patcher/asar.ts",
        find: 'if (typeof filesNode !== "object" || filesNode === null) {',
        with: "if (false) {",
        expect: "rejects a header that parses but has no file table, without throwing"
    },
    {
        name: "asar: entry data read without the archive's data offset",
        file: "src/patcher/asar.ts",
        find: "readSync(fd, buf, 0, entry.size, directory.dataOffset + entry.offset)",
        with: "readSync(fd, buf, 0, entry.size, entry.offset)",
        expect: "reads payload out of a foreign archive at the padded data offset"
    },
    {
        name: "asar: entry data read without the entry's own offset",
        file: "src/patcher/asar.ts",
        find: "readSync(fd, buf, 0, entry.size, directory.dataOffset + entry.offset)",
        with: "readSync(fd, buf, 0, entry.size, directory.dataOffset)",
        expect: "reads payload out of a foreign archive at the padded data offset"
    },
    {
        name: "asar: reading absent entries returns an empty map instead of failing",
        file: "src/patcher/asar.ts",
        find: "if (missing.length > 0) {",
        with: "if (false) {",
        expect: "refuses to read entries the archive does not contain"
    },

    /* ---- patcher/stub.ts ---- */
    {
        name: "stub: any archive containing index.js and package.json is a stub",
        file: "src/patcher/stub.ts",
        find: "names.size === 2 && names.has(STUB_INDEX_NAME) && names.has(STUB_PACKAGE_NAME)",
        with: "names.has(STUB_INDEX_NAME) && names.has(STUB_PACKAGE_NAME)",
        expect: "does not call a three-entry archive a loader stub"
    },

    /* ---- the literal fixtures themselves ----
     *
     * If the transcribed bytes drift from the live archive they describe, the
     * reader tests above are pinned to nothing. These mutate the fixture rather
     * than the source, so a wrong constant has to be caught too.
     */
    {
        name: "fixture: the real stub's header pickle length is transcribed wrongly",
        file: "tests/fixture.ts",
        find: "    buf.writeUInt32LE(96, 4);",
        with: "    buf.writeUInt32LE(100, 4);",
        expect: "the literal fixture really is the bytes captured from the live install"
    },
    {
        name: "fixture: the foreign archive's header length is transcribed wrongly",
        file: "tests/fixture.ts",
        find: "    buf.writeUInt32LE(318, 12);",
        with: "    buf.writeUInt32LE(316, 12);",
        expect: "reads a foreign archive with padding, nested dirs, integrity, unpacked and link entries"
    },
    {
        name: "fixture: the foreign archive's alignment padding carries data",
        file: "tests/fixture.ts",
        find: '    buf.write(FOREIGN_BUNDLE_JS, 336, "utf8");',
        with: '    buf.write("XX", 334, "utf8");\n    buf.write(FOREIGN_BUNDLE_JS, 336, "utf8");',
        expect: "the foreign-original literal describes the bytes it claims to"
    },

    /* ---- tests/helper.test.ts: the fixture clock ----
     *
     * START must stay RELATIVE to the real clock. As a fixed instant it worked
     * until real time overtook it, then failed four health tests with no code
     * change. This mutation restores the fixed instant it used to be.
     */
    {
        name: "helper fixture: the clock anchor is a fixed instant again",
        file: "tests/helper.test.ts",
        find: "const START = Date.now() + 24 * 60 * 60 * 1000;",
        with: 'const START = Date.parse("2026-08-07T09:00:00.000Z");',
        expect: "says QUIET, and warns nobody, for an install with nothing to translate"
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
    const equivalents = [];
    const invariantMoved = [];
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

        if (mutation.equivalent) {
            // Expected to survive. Being killed is the interesting outcome.
            if (died) {
                invariantMoved.push(`${mutation.name} — marked equivalent ("${mutation.equivalent}") but the suite caught it`);
                console.log(`INVARIANT MOVED  ${mutation.name}  [${result.failedTests}/${result.total} failing]`);
            } else {
                equivalents.push(mutation.name);
                console.log(`EQUIVALENT ${mutation.name}  [cannot change behaviour: ${mutation.equivalent}]`);
            }
            continue;
        }

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

    const scored = MUTATIONS.length - equivalents.length - invariantMoved.length;
    console.log(
        `\n${killed}/${scored} killed, ${survivors.length} survivors`
        + `${equivalents.length === 0 ? "" : `, ${equivalents.length} equivalent (expected to survive)`}.`
    );
    for (const note of wrongTest) console.log(`  note: ${note}`);
    for (const equivalent of equivalents) console.log(`  equivalent: ${equivalent}`);
    for (const moved of invariantMoved) console.log(`  INVARIANT MOVED: ${moved}`);
    for (const survivor of survivors) console.log(`  SURVIVOR: ${survivor}`);
    process.exit(survivors.length === 0 && invariantMoved.length === 0 ? 0 : 1);
}

main();
