const defaultSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export async function withRetry<T>(
    fn: () => Promise<T>,
    opts: {
        retries: number;
        delayMs: number;
        sleep?: (ms: number) => Promise<void>;
        shouldRetry?: (err: unknown) => boolean;
    }
): Promise<T> {
    const sleep = opts.sleep ?? defaultSleep;
    const shouldRetry = opts.shouldRetry ?? (() => true);
    // A negative retry count would otherwise skip the loop entirely and
    // `throw lastError` as `undefined`; clamp so at least one attempt runs.
    const retries = Math.max(0, opts.retries);
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            if (!shouldRetry(err)) throw err;
            if (attempt < retries) await sleep(opts.delayMs);
        }
    }
    throw lastError;
}
