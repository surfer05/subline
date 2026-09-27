/**
 * The Upgrade panel: a Discord modal with the two plans.
 *
 * Built on the modal Vencord itself uses (`Modal` + `openModal` from
 * @webpack/common, as in Vencord's own badges plugin at the pinned commit), so
 * no Discord patch is involved. The plan buttons are the modal's own `actions`.
 * If the modal cannot be shown at all, the pricing page opens instead.
 */
import { Modal, openModal, React } from "@webpack/common";

import type { Plan } from "./checkout";
import { PRICING_URL } from "./freePlan";
import { UPGRADE_COPY } from "./upgradeCopy";

export function UpgradePanelBody() {
    const row = { display: "flex", justifyContent: "space-between", padding: "8px 0", color: "var(--text-default, var(--text-normal))" };
    const muted = { color: "var(--text-muted)", fontSize: "0.9rem" };
    return (
        <div>
            <div style={row}>
                <strong>{UPGRADE_COPY.monthlyName}</strong>
                <span>{UPGRADE_COPY.monthlyPrice}</span>
            </div>
            <div style={row}>
                <strong>{UPGRADE_COPY.annualName}</strong>
                <span>{UPGRADE_COPY.annualPrice} <span style={muted}>({UPGRADE_COPY.annualNote})</span></span>
            </div>
            <div style={{ ...muted, paddingTop: 8 }}>{UPGRADE_COPY.panelFootnote}</div>
        </div>
    );
}

/** Open the panel. `choose` runs when a plan button is pressed, after the panel closes. */
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
        (globalThis as any).VencordNative?.native?.openExternal?.(PRICING_URL);
    }
}
