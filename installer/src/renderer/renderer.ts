/**
 * The renderer. UI ONLY.
 *
 * It draws whatever `FlowState` it is handed and sends back the actions that
 * state offered. It contains no filesystem access, no decisions about what may
 * happen next, and — most importantly — no opinion about what counts as
 * success: the green tick below is driven by `verification.confirmed`, which
 * only `verifyOnce` sets, and only for a translation that was actually painted.
 *
 * The buttons are generated from `state.actions`. Nothing here can offer a way
 * past a refusal, because there is no list of buttons in this file to add one
 * to.
 */

import type { FlowAction, FlowActionType, FlowState } from "../app/flow.js";
import type { LanguageOption } from "../app/language.js";
import type { UninstallReport } from "../app/uninstall.js";

interface SublineApi {
    start(): Promise<FlowState>;
    send(action: FlowAction): Promise<FlowState>;
    restart(): Promise<FlowState>;
    pickDiscord(): Promise<string | null>;
    copyDiagnostics(): Promise<number>;
    readDiagnostics(): Promise<string>;
    uninstall(options: { keepSettings: boolean }): Promise<UninstallReport>;
    openUrl(url: string): Promise<boolean>;
    onState(handler: (state: FlowState) => void): () => void;
}

declare global {
    interface Window { subline: SublineApi }
}

const api = window.subline;

const stepName = document.getElementById("step-name") as HTMLParagraphElement;
const detail = document.getElementById("detail") as HTMLParagraphElement;
const extra = document.getElementById("extra") as HTMLDivElement;
const errorBox = document.getElementById("error") as HTMLDivElement;
const actionBar = document.getElementById("actions") as HTMLDivElement;

/** Human labels. A step with no entry falls back to its own id, which is fine for a log-shaped state. */
const STEP_TITLES: Partial<Record<FlowState["step"], string>> = {
    welcome: "Welcome",
    tiers: "Two levels of translation",
    detecting: "Looking for Discord",
    "discord-not-found": "Discord not found",
    "choose-install": "Which Discord?",
    "mod-bundle-invalid": "Subline is damaged",
    "broken-install": "Discord needs repairing",
    "betterdiscord-blocked": "BetterDiscord is installed",
    "mod-conflict": "Another mod is installed",
    "already-installed": "Subline is already set up",
    "discord-running": "Discord is running",
    "quit-blocked": "Discord is still running",
    "choose-language": "Your reading language",
    "permission-explain": "macOS needs your permission",
    "permission-waiting": "Waiting for permission",
    "permission-blocked": "Permission not granted",
    patching: "Installing",
    "patch-failed": "Could not install",
    "installing-helper": "Setting up background updates",
    "helper-failed": "Background updates are not set up",
    launching: "Starting Discord",
    "launch-failed": "Could not start Discord",
    verifying: "Checking it works",
    done: "Finished",
    cancelled: "Cancelled"
};

const ACTION_LABELS: Record<FlowActionType, string> = {
    next: "Continue",
    cancel: "Cancel",
    "pick-path": "Choose Discord…",
    "choose-install": "Choose",
    "proceed-over-mod": "Replace it and continue",
    "quit-discord": "Quit Discord for me",
    // Says what it does. "Try again" here would hide that this one does not ask
    // Discord first — the user is consenting to the close, which is the whole
    // reason a forced quit is allowed to exist at all.
    "force-quit-discord": "Close Discord anyway",
    recheck: "Check again",
    "set-language": "Continue",
    "open-permission-settings": "Open System Settings",
    retry: "Try again",
    // Named for what it costs, not for what it skips. "Continue" here would let
    // someone give up the thing that keeps their install alive without ever
    // learning they had.
    "skip-helper": "Continue without background updates",
    "skip-launch": "I'll open Discord myself",
    finish: "Done"
};

/** Which action gets the filled button. One per screen, never two. */
const PRIMARY: FlowActionType[] = ["next", "set-language", "proceed-over-mod", "quit-discord", "force-quit-discord", "retry", "finish", "open-permission-settings"];

let chosenLanguage: string | null = null;

/**
 * The heading, with one override.
 *
 * `broken-install` normally does mean Discord is damaged. But the same step is
 * reached when we merely could not OPEN app.asar — a permissions problem on a
 * perfectly healthy install. Announcing "Discord needs repairing" there, beside
 * a repair button and an Uninstall link, points the user at destructive
 * remedies for a file that was never broken. See BrokenReason's
 * `asar-inaccessible`.
 */
function headingFor(state: FlowState): string {
    const s = state as FlowState & { installState?: { kind?: string; reason?: string | null } };
    if (
        state.step === "broken-install"
        && s.installState?.kind === "broken"
        && s.installState.reason === "asar-inaccessible"
    ) {
        return "Subline couldn't read Discord";
    }
    return STEP_TITLES[state.step] ?? state.step;
}

function render(state: FlowState): void {
    stepName.textContent = headingFor(state);

    detail.textContent = state.detail;
    if (state.busy) {
        const spinner = document.createElement("span");
        spinner.className = "spinner";
        detail.prepend(spinner, document.createTextNode(" "));
    }

    errorBox.hidden = state.error === null;
    if (state.error !== null) {
        // The cause carries Node's errno, and dropping it is how a real failure
        // reached a user as a bare "IO_ERROR — <path>": enough to know something
        // broke, not enough for anyone to say what. It is the last line because
        // the code and path are what a user reads; the errno is what we do.
        const cause = (state.error as { cause?: string }).cause;
        errorBox.textContent = `${state.error.code}${state.error.path ? ` — ${state.error.path}` : ""}`
            + (cause === undefined ? "" : `\n${cause}`);
    }

    extra.replaceChildren();
    renderExtra(state);
    renderActions(state);
}

function renderExtra(state: FlowState): void {
    if (state.step === "choose-install" && state.installs) {
        const list = document.createElement("ul");
        list.className = "list";
        for (const install of state.installs) {
            const item = document.createElement("li");
            const button = document.createElement("button");
            button.textContent = install.rootPath;
            button.onclick = () => void act({ type: "choose-install", rootPath: install.rootPath });
            item.append(button);
            list.append(item);
        }
        extra.append(list);
    }

    if (state.step === "choose-language" && state.languages) {
        chosenLanguage = state.language ?? null;
        const label = document.createElement("label");
        label.textContent = "Translate messages into";
        const select = document.createElement("select");
        for (const option of state.languages as LanguageOption[]) {
            const node = document.createElement("option");
            node.value = option.code;
            // English names only, by the product owner's call: "Español —
            // Spanish" reads as noise to someone who can read either half.
            //
            // This trades away what §3a wanted the endonym for — a user who
            // reads no English finding their own language — so if that user
            // ever shows up, this line is where they were lost, not the list.
            node.textContent = option.englishName;
            if (option.code === state.language) node.selected = true;
            select.append(node);
        }
        select.onchange = () => { chosenLanguage = select.value; };
        extra.append(label, select);
    }

    if (state.step === "discord-running" && state.processes) {
        const note = document.createElement("p");
        note.className = "sub";
        note.textContent = `Running as process ${state.processes.map(p => p.pid).join(", ")}.`;
        extra.append(note);
    }

    if (state.step === "done" && state.verification) {
        const verdict = document.createElement("p");
        // THE ONLY PLACE A TICK IS DRAWN, and it reads `confirmed` — never
        // "we got to the last screen".
        verdict.className = state.verification.confirmed ? "ok" : "warn";
        verdict.textContent = state.verification.confirmed
            ? "✓ Translation is working."
            : "Installed — but we could not confirm it is working.";
        const status = document.createElement("p");
        status.className = "sub";
        status.textContent = `Status: ${state.verification.status}`;
        extra.append(verdict, status);
    }

    if (state.permissionSettingsUrl !== undefined && state.step !== "done") {
        const hint = document.createElement("p");
        hint.className = "sub";
        hint.textContent = "System Settings › Privacy & Security › App Management";
        extra.append(hint);
    }
}

function renderActions(state: FlowState): void {
    actionBar.replaceChildren();
    for (const action of state.actions) {
        // `choose-install` is rendered as the list above, not as a footer button.
        if (action === "choose-install") continue;
        const button = document.createElement("button");
        button.textContent = ACTION_LABELS[action];
        if (PRIMARY.includes(action)) button.className = "primary";
        button.disabled = state.busy;
        button.onclick = () => void onAction(action);
        actionBar.append(button);
    }
}

async function onAction(action: FlowActionType): Promise<void> {
    if (action === "pick-path") {
        const path = await api.pickDiscord();
        if (path === null) return;
        await act({ type: "pick-path", path });
        return;
    }
    if (action === "set-language") {
        await act({ type: "set-language", code: chosenLanguage ?? "en" });
        return;
    }
    if (action === "finish") {
        window.close();
        return;
    }
    await act({ type: action } as FlowAction);
}

async function act(action: FlowAction): Promise<void> {
    render(await api.send(action));
}

document.getElementById("copy-diagnostics")?.addEventListener("click", () => {
    void api.copyDiagnostics().then(bytes => {
        const button = document.getElementById("copy-diagnostics") as HTMLButtonElement;
        button.textContent = `Copied ${bytes} bytes`;
        setTimeout(() => { button.textContent = "Copy diagnostics"; }, 2500);
    });
});

document.getElementById("uninstall")?.addEventListener("click", () => {
    const keepSettings = !confirm(
        "Remove your settings as well?\n\nOK removes them. Cancel keeps them, so reinstalling picks up where you left off."
    );
    void api.uninstall({ keepSettings }).then(report => {
        detail.textContent = report.summary;
        stepName.textContent = report.clean ? "Removed" : "Not fully removed";
        extra.replaceChildren();
        actionBar.replaceChildren();
        errorBox.hidden = report.problems.length === 0;
        errorBox.textContent = report.problems.map(problem => problem.code).join(", ");
    });
});

api.onState(render);
void api.start().then(render);
