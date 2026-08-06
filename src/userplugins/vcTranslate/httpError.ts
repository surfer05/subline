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
 *
 * `quotaLimitPerMinute` rides along for the same reason: a 429 body sometimes
 * states the quota it just enforced ("limit: 20" — see rateHint.ts), and the
 * rate gate in the renderer wants that number, but the only code that ever
 * sees the response body is the engine. Without a slot here it would be
 * parsed and then thrown away.
 *
 * `quotaModel` rides along for the same reason again: a 429 body sometimes
 * names the model whose quota was exceeded ("model: gemini-3.6-flash"), and
 * that name is the only thing that distinguishes "this key cannot call this
 * model AT ALL" from "you are sending too fast". Without it the renderer can
 * only ever say the second, which is what left a permanently-429ing model
 * undiagnosed for days.
 */
export class HttpError extends Error {
    readonly status: number;
    readonly retryAfterMs?: number;
    readonly quotaLimitPerMinute?: number;
    readonly quotaModel?: string;

    constructor(
        message: string,
        status: number,
        retryAfterMs?: number,
        quotaLimitPerMinute?: number,
        quotaModel?: string
    ) {
        super(message);
        this.name = "HttpError";
        this.status = status;
        this.retryAfterMs = retryAfterMs;
        this.quotaLimitPerMinute = quotaLimitPerMinute;
        this.quotaModel = quotaModel;
    }
}
