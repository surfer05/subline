/**
 * The Activate panel, the Add AI panel and the code entry: Discord modals.
 *
 * Built on the modal Vencord itself uses (`Modal` + `openModal` from
 * @webpack/common, as in Vencord's own badges plugin at the pinned commit), so
 * no Discord patch is involved. The buttons are the modal's own `actions`.
 * If a modal cannot be shown at all, the pricing page opens instead.
 *
 * The code field is a plain <input>: its value is read from the closure when
 * Activate is pressed, so the modal needs no React state of its own, and a
 * refusal is said in a toast while the modal stays open for another try.
 */
import { Modal, openModal, React, Toasts } from "@webpack/common";

import type { Plan } from "./checkout";
import { PRICING_URL } from "./freePlan";
import { UPGRADE_COPY } from "./upgradeCopy";

const ROW = { display: "flex", justifyContent: "space-between", padding: "8px 0", color: "var(--text-default, var(--text-normal))" };
const MUTED = { color: "var(--text-muted)", fontSize: "0.9rem" };

function openPricingInstead(): void {
    (globalThis as any).VencordNative?.native?.openExternal?.(PRICING_URL);
}

/* ------------------------------------------------------------ Add AI -- */

export function UpgradePanelBody() {
    return (
        <div>
            <div style={ROW}>
                <strong>{UPGRADE_COPY.monthlyName}</strong>
                <span>{UPGRADE_COPY.monthlyPrice}</span>
            </div>
            <div style={ROW}>
                <strong>{UPGRADE_COPY.annualName}</strong>
                <span>{UPGRADE_COPY.annualPrice} <span style={MUTED}>({UPGRADE_COPY.annualNote})</span></span>
            </div>
            <div style={{ ...MUTED, paddingTop: 8 }}>{UPGRADE_COPY.panelFootnote}</div>
        </div>
    );
}

/** The Add AI panel, for an Automatic owner. `choose` runs after the panel closes. */
export function openUpgradePanel(choose: (plan: Plan) => void): void {
    try {
        openModal((props: any) => (
            <Modal
                {...props}
                title={UPGRADE_COPY.panelTitle}
                subtitle={UPGRADE_COPY.panelSubtitle}
                actions={[
                    { text: UPGRADE_COPY.monthlyButton, variant: "secondary", onClick: () => { props.onClose(); choose("monthly"); } },
                    { text: UPGRADE_COPY.annualButton, variant: "primary", onClick: () => { props.onClose(); choose("annual"); } }
                ]}
            >
                <UpgradePanelBody />
            </Modal>
        ));
    } catch {
        openPricingInstead();
    }
}

/* ---------------------------------------------------------- Activate -- */

export function ActivatePanelBody() {
    return (
        <div>
            <div style={ROW}>
                <strong>{UPGRADE_COPY.automaticName}</strong>
                <span>{UPGRADE_COPY.automaticPrice}</span>
            </div>
            <div style={MUTED}>{UPGRADE_COPY.automaticNote}</div>
            <div style={{ ...MUTED, paddingTop: 8 }}>{UPGRADE_COPY.panelFootnote}</div>
        </div>
    );
}

/** The Activate panel, for an install with nothing: buy Automatic, or enter a code. */
export function openActivatePanel(actions: { buy: () => void; enterCode: () => void; }): void {
    try {
        openModal((props: any) => (
            <Modal
                {...props}
                title={UPGRADE_COPY.activateTitle}
                subtitle={UPGRADE_COPY.activateSubtitle}
                actions={[
                    { text: UPGRADE_COPY.enterCodeButton, variant: "secondary", onClick: () => { props.onClose(); actions.enterCode(); } },
                    { text: UPGRADE_COPY.automaticButton, variant: "primary", onClick: () => { props.onClose(); actions.buy(); } }
                ]}
            >
                <ActivatePanelBody />
            </Modal>
        ));
    } catch {
        openPricingInstead();
    }
}

/* -------------------------------------------------------- code entry -- */

const INPUT_STYLE = {
    width: "100%",
    boxSizing: "border-box",
    padding: "8px 10px",
    marginTop: 8,
    borderRadius: 4,
    border: "1px solid var(--border-subtle, var(--background-modifier-accent, #4e5058))",
    background: "var(--input-background, var(--background-secondary, #1e1f22))",
    color: "var(--text-default, var(--text-normal, #dbdee1))",
    fontSize: "1rem"
} as const;

/**
 * The code entry. `submit` gets the typed text and resolves null when the
 * code worked (the modal closes) or the sentence to show when it did not
 * (a toast; the modal stays open).
 */
export function openCodeEntry(submit: (text: string) => Promise<string | null>): void {
    // Outside the render function: Discord renders a modal more than once
    // (its open transition), and the typed text must survive that.
    let value = "";
    let busy = false;
    try {
        openModal((props: any) => {
            const go = async () => {
                if (busy) return;
                busy = true;
                try {
                    const error = await submit(value);
                    if (error === null) props.onClose();
                    else Toasts.show({ id: Toasts.genId(), type: Toasts.Type.FAILURE, message: error });
                } finally {
                    busy = false;
                }
            };
            return (
                <Modal
                    {...props}
                    title={UPGRADE_COPY.codeTitle}
                    subtitle={UPGRADE_COPY.codeSubtitle}
                    actions={[
                        { text: UPGRADE_COPY.codeSubmit, variant: "primary", onClick: () => { void go(); } }
                    ]}
                >
                    <input
                        type="text"
                        autoFocus
                        spellCheck={false}
                        placeholder={UPGRADE_COPY.codePlaceholder}
                        style={INPUT_STYLE}
                        onChange={(e: any) => { value = String(e?.target?.value ?? ""); }}
                        onKeyDown={(e: any) => { if (e?.key === "Enter") { e.preventDefault?.(); void go(); } }}
                    />
                </Modal>
            );
        });
    } catch {
        openPricingInstead();
    }
}
