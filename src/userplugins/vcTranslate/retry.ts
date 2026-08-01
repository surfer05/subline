const defaultSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export async function withRetry<T>(
    fn: () => Promise<T>,
    opts: { retries: number; delayMs: number; sleep?: (ms: number) => Promise<void> }
): Promise<T> {
    const sleep = opts.sleep ?? defaultSleep;
    let lastError: unknown;

    for (let attempt = 0; attempt <= opts.retries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            if (attempt < opts.retries) await sleep(opts.delayMs);
        }
    }
    throw lastError;
}
