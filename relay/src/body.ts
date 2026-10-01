/**
 * Reading a request body with a hard byte ceiling.
 *
 * `req.arrayBuffer()` and `req.text()` buffer the WHOLE body before anything
 * can look at its size, so a 100 MB post would sit in an isolate that has a
 * 128 MB memory limit and can take down other requests sharing it. This reads
 * the stream chunk by chunk and stops as soon as the ceiling is passed.
 */

/** The bytes of the body, or null when it is larger than `max`. */
export async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
    const declared = Number(req.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > max) {
        try { await req.body?.cancel(); } catch { /* already released */ }
        return null;
    }
    if (!req.body) return new Uint8Array(0);
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > max) {
            try { await reader.cancel(); } catch { /* already released */ }
            return null;
        }
        chunks.push(value);
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.byteLength; }
    return out;
}

/** The body as text, or null when it is larger than `max`. */
export async function readCappedText(req: Request, max: number): Promise<string | null> {
    const bytes = await readCapped(req, max);
    return bytes === null ? null : new TextDecoder().decode(bytes);
}

/** Small JSON bodies (checkout, redeem, admin): a few hundred bytes at most. */
export const SMALL_BODY_BYTES = 8_192;
