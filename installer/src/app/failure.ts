/**
 * The screen for a throw nobody expected (audit 2026-10-06 #20).
 *
 * Without it, a throw inside a flow transition rejected the IPC call, the
 * renderer never drew the next state, and the window sat on a busy screen
 * with nothing to press. Now the main process (and, as a backstop, the
 * renderer) turns any throw into this state: one sentence, the cause in the
 * diagnostics box, and Done. No imports, so the renderer can load it too.
 */

export const UNEXPECTED_FAILURE_COPY = {
    title: "Something went wrong",
    detail: "Subline hit an unexpected error. Copy diagnostics if you want to send them, then close Subline and open it again."
} as const;

export interface UnexpectedFailureState {
    step: "failed";
    detail: string;
    actions: ["finish"];
    busy: false;
    error: { code: "UNEXPECTED"; message: string; cause?: string };
}

export function unexpectedFailureState(cause: unknown): UnexpectedFailureState {
    const text = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    return {
        step: "failed",
        detail: UNEXPECTED_FAILURE_COPY.detail,
        actions: ["finish"],
        busy: false,
        error: { code: "UNEXPECTED", message: UNEXPECTED_FAILURE_COPY.detail, cause: text.slice(0, 500) }
    };
}

/**
 * Run a flow call; a throw becomes the failure state, logged with its cause.
 * Used by every flow IPC handler in main.ts.
 */
export async function guardedFlowCall<T>(
    run: () => Promise<T> | T,
    onCrash: (cause: unknown) => void
): Promise<T | UnexpectedFailureState> {
    try {
        return await run();
    } catch (cause) {
        try {
            onCrash(cause);
        } catch {
            // The log never throws; this is belt and braces.
        }
        return unexpectedFailureState(cause);
    }
}
