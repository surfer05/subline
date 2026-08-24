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

import { ACTION_LABELS, IS_PRIMARY } from "../app/actions.js";
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
    uninstall(options: { keepSettings: boolean; closeDiscord?: "ask" | "force" }): Promise<UninstallReport>;
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

/**
 * Human labels — a FULL Record, so adding a FlowStep fails to compile here.
 *
 * It used to be Partial, with `?? state.step` as the fallback, which meant a
 * new state shipped with its own kebab-case id as the heading and nothing
 * anywhere said so. ACTION_LABELS below was already a full Record and did catch
 * a new action; the asymmetry was not a decision.
 */
const STEP_TITLES: Record<FlowState["step"], string> = {
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
    "choose-key": "Better translations",
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





let chosenLanguage: string | null = null;
let typedKey = "";

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
    // No cast. `installState` is already InstallState, whose `reason` is
    // BrokenReason — so renaming that literal breaks this comparison at compile
    // time instead of silently sending someone to a destructive "repair" for a
    // file that was never broken, which is the bug this heading exists to fix.
    if (
        state.step === "broken-install"
        && state.installState?.kind === "broken"
        && state.installState.reason === "asar-inaccessible"
    ) {
        return "Subline couldn't read Discord";
    }
    return STEP_TITLES[state.step];
}

function render(state: FlowState): void {
    stepName.textContent = headingFor(state);

    detail.textContent = state.detail;
    if (state.busy) {
        const spinner = document.createElement("span");
        spinner.className = "spin";
        detail.prepend(spinner, document.createTextNode(" "));
    }

    errorBox.hidden = state.error === null;
    errorBox.replaceChildren();
    if (state.error !== null) renderError(state.error);

    extra.replaceChildren();
    renderExtra(state);
    renderActions(state);
}

function renderExtra(state: FlowState): void {
    if (state.step === "choose-install" && state.installs) {
        const list = document.createElement("ul");
        list.className = "rows panel pick";
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
        const field = document.createElement("div");
        field.className = "fld";
        const label = document.createElement("label");
        label.className = "lbl";
        label.textContent = "Translate messages into";
        const select = document.createElement("select");
        select.className = "sel";
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
        field.append(label, select);
        extra.append(field);
    }

    if (state.step === "choose-key") {
        typedKey = "";
        const field = document.createElement("div");
        field.className = "fld";

        const label = document.createElement("label");
        label.className = "lbl";
        label.textContent = "API key";

        const input = document.createElement("input");
        input.className = "sel";
        input.type = "text";
        input.placeholder = "gsk_…";
        // Not type="password": this is pasted once, and a masked field makes a
        // mis-paste impossible to spot — which is exactly the failure that had
        // a valid key reported as rejected.
        input.autocomplete = "off";
        input.spellcheck = false;
        input.oninput = () => { typedKey = input.value; };
        input.onkeydown = event => {
            if (event.key === "Enter" && typedKey.trim() !== "") void onAction("set-key");
        };

        const hint = document.createElement("p");
        hint.className = "note";
        if (state.keySignupUrl !== undefined) {
            const link = document.createElement("a");
            link.href = "#";
            link.textContent = "Get a free key";
            link.onclick = event => {
                event.preventDefault();
                void api.openUrl(state.keySignupUrl as string);
            };
            hint.append(link, document.createTextNode(" — it takes a minute, and costs nothing."));
        }

        field.append(label, input, hint);
        extra.append(field);
        // Focus so a paste works without hunting for the field.
        setTimeout(() => input.focus(), 0);
    }

    if (state.step === "discord-running" && state.processes) {
        const note = document.createElement("p");
        note.className = "note";
        note.textContent = `Running as process ${state.processes.map(p => p.pid).join(", ")}.`;
        extra.append(note);
    }

    if (state.step === "done" && state.verification) {
        // THE ONLY PLACE A TICK IS DRAWN, and it reads `confirmed` — never
        // "we got to the last screen". The two endings are different shapes as
        // well as different colours (✓ against a ring), because the design
        // contract requires them to survive greyscale — see §4.1.
        const confirmed = state.verification.confirmed;
        extra.append(verdictBlock({
            tone: confirmed ? "ok" : "warn",
            glyph: confirmed ? "✓" : "?",
            heading: confirmed ? "Confirmed working" : "Installed, not yet confirmed",
            body: confirmed
                ? "We watched a translation render in Discord just now. Not an assumption — an observation."
                : "Every file was written correctly. No message in another language arrived while we watched.",
            status: state.verification.status
        }));
    }

    if (state.permissionSettingsUrl !== undefined && state.step !== "done") {
        const hint = document.createElement("p");
        hint.className = "note";
        hint.textContent = "System Settings › Privacy & Security › App Management";
        extra.append(hint);
    }
}


/**
 * The failure detail, as a disclosure that stays copyable.
 *
 * Invariant §4.3: every failure carries a code, a path and an underlying cause,
 * and all of it must remain selectable. The cause is where Node's errno lives —
 * dropping it is how a real Windows failure reached a user as a bare
 * "IO_ERROR", with the diagnostics bundle knowing no more than the screenshot
 * did. It is a <details> rather than a wall of text so the code leads and the
 * rest is there when someone needs it.
 */
function renderError(error: { code: string; message?: string; path?: string; cause?: string }): void {
    const details = document.createElement("details");
    details.className = "err";

    const summary = document.createElement("summary");
    const label = document.createElement("span");
    label.append("What went wrong · ");
    const code = document.createElement("code");
    code.textContent = error.code;
    label.append(code);
    const chevron = document.createElement("span");
    chevron.className = "chev";
    chevron.textContent = "▸";
    summary.append(label, chevron);

    const list = document.createElement("dl");
    const row = (term: string, value: string): void => {
        const dt = document.createElement("dt");
        dt.textContent = term;
        const dd = document.createElement("dd");
        dd.textContent = value;
        list.append(dt, dd);
    };
    row("code", error.code);
    if (error.message !== undefined) row("message", error.message);
    if (error.path !== undefined) row("path", error.path);
    if (error.cause !== undefined) row("cause", error.cause);

    details.append(summary, list);
    errorBox.append(details);
}

/**
 * The end-of-run verdict.
 *
 * Two outcomes, and they differ by SHAPE as well as colour — a tick against a
 * ring — because §4.1 requires the confirmed and unconfirmed endings to survive
 * greyscale. Nothing here decides which one is shown; that is
 * `verification.confirmed`, and only `verifyOnce` sets it.
 */
function verdictBlock(spec: {
    tone: "ok" | "warn";
    glyph: string;
    heading: string;
    body: string;
    status: string;
}): HTMLElement {
    const block = document.createElement("div");
    block.className = `verdict v-${spec.tone}`;

    const mark = document.createElement("span");
    mark.className = `vm ${spec.tone === "ok" ? "vm-ok" : "vm-ring"}`;
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = spec.glyph;

    const copy = document.createElement("div");
    const heading = document.createElement("h2");
    heading.textContent = spec.heading;
    const body = document.createElement("p");
    body.textContent = spec.body;
    const status = document.createElement("p");
    status.className = "note";
    status.textContent = `Status: ${spec.status}`;
    copy.append(heading, body, status);

    block.append(mark, copy);
    return block;
}

function renderActions(state: FlowState): void {
    actionBar.replaceChildren();
    for (const action of state.actions) {
        // `choose-install` is rendered as the list above, not as a footer button.
        if (action === "choose-install") continue;
        const button = document.createElement("button");
        button.textContent = ACTION_LABELS[action];
        button.className = IS_PRIMARY[action] ? "btn btn-primary" : "btn btn-secondary";
        button.disabled = state.busy;
        button.onclick = () => void onAction(action);
        actionBar.append(button);
    }
}

/**
 * A switch, not a chain of ifs with a cast at the end.
 *
 * The cast that used to close this function (`{ type: action } as FlowAction`)
 * was the only thing standing between two unions. An action that grew a payload
 * would still compile here and ship `{ type }` with the payload missing —
 * `flow.send` accepts it, since its gate checks only `action.type`, and the
 * handler then reads `undefined`. A bug with no error anywhere.
 *
 * In the default branch `action` is narrowed to the cases not handled above,
 * and `{ type: action }` has to be assignable to FlowAction on its own merits.
 * Give any of those a payload and this line stops compiling.
 */
async function onAction(action: FlowActionType): Promise<void> {
    switch (action) {
        case "pick-path": {
            const path = await api.pickDiscord();
            if (path === null) return;
            await act({ type: "pick-path", path });
            return;
        }
        case "set-language":
            await act({ type: "set-language", code: chosenLanguage ?? "en" });
            return;
        case "set-key":
            await act({ type: "set-key", key: typedKey });
            return;
        case "finish":
            window.close();
            return;
        case "choose-install":
            // Never arrives here. It carries a rootPath and is dispatched from
            // the list `renderExtra` draws, which is also why `renderActions`
            // skips it. Two places have to agree about that, and until this
            // switch existed neither the type nor a test said so — the cast at
            // the end of this function was quietly accepting it.
            return;
        default:
            await act({ type: action });
    }
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

/**
 * Failures an open Discord causes, and which nothing but closing it will fix.
 *
 * DISCORD_RUNNING is the one we check for up front. FILE_IN_USE is the same
 * situation discovered the hard way — Windows refusing to rename a file that is
 * held open — and it is listed because a user who sees it can do exactly the
 * same thing about it.
 */
const CLOSING_DISCORD_WOULD_HELP = ["DISCORD_RUNNING", "FILE_IN_USE"];

/**
 * Show what an uninstall did, and — when the obstacle is a running Discord —
 * offer to remove it rather than describing it.
 *
 * "One click to install, one click to remove" is not met by handing somebody a
 * file error and leaving them to work out that the remedy is to quit an app
 * they believe is already closed. The escalation matches the install flow's:
 * ask Discord politely, and only if that fails offer the forced close, on a
 * button that says so. On Windows the polite request merely hides Discord in
 * the system tray, which is why the second step has to exist at all.
 */
function showUninstall(report: UninstallReport, mayRetry: boolean): void {
    detail.textContent = report.summary;
    stepName.textContent = report.clean ? "Removed" : "Not fully removed";
    extra.replaceChildren();
    actionBar.replaceChildren();

    errorBox.hidden = report.problems.length === 0;
    errorBox.replaceChildren();
    const first = report.problems[0];
    if (first !== undefined) renderError(first);

    if (first === undefined || !CLOSING_DISCORD_WOULD_HELP.includes(first.code)) return;
    // Offered ONCE. The main process escalates from a polite request to a
    // forced close inside that single press, so a second failure means
    // something other than an open Discord is holding the files, and another
    // button would only repeat work that has already been done.
    if (!mayRetry) return;

    const button = document.createElement("button");
    button.className = "btn btn-primary";
    button.textContent = "Quit Discord and remove";
    button.onclick = () => {
        button.disabled = true;
        void runUninstall(lastKeepSettings, "ask", false);
    };
    actionBar.append(button);
}

let lastKeepSettings = true;

function runUninstall(
    keepSettings: boolean,
    closeDiscord: "ask" | "force" | null,
    mayRetry: boolean
): Promise<void> {
    lastKeepSettings = keepSettings;
    return api
        .uninstall(closeDiscord === null ? { keepSettings } : { keepSettings, closeDiscord })
        .then(report => showUninstall(report, mayRetry));
}

document.getElementById("uninstall")?.addEventListener("click", () => {
    const keepSettings = !confirm(
        "Remove your settings as well?\n\nOK removes them. Cancel keeps them, so reinstalling picks up where you left off."
    );
    void runUninstall(keepSettings, null, true);
});

api.onState(render);
void api.start().then(render);
