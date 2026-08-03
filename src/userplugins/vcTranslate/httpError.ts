/**
 * Thrown by an engine on a non-OK HTTP response. A plain `Error` only carries
 * a message string, so the only way native.ts could previously know the
 * status was to regex it back out of the message — and there was nowhere at
 * all to carry a parsed retry hint (see rateHint.ts) from the engine, which
 * saw the actual Response object, back to native.ts, which only sees
 * whatever the engine threw. `status` and `retryAfterMs` ride along as real
 * properties instead.
 *
 * `retryAfterMs` is deliberately optional and engine-supplied rather than
 * computed here: not every non-OK response carries a retry hint, and this
 * class has no opinion about what a missing one should default to (that
 * fallback is native.ts's `30_000` constant, applied only for a 429).
 */
export class HttpError extends Error {
    readonly status: number;
    readonly retryAfterMs?: number;

    constructor(message: string, status: number, retryAfterMs?: number) {
        super(message);
        this.name = "HttpError";
        this.status = status;
        this.retryAfterMs = retryAfterMs;
    }
}
