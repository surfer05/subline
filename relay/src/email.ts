/**
 * The one place that touches `cloudflare:email`, so everything else (and every
 * test) can stay free of the Workers-only module. Tests alias this specifier
 * to a stub (vitest.config.ts).
 */
import { EmailMessage } from "cloudflare:email";

/** A message for a `send_email` binding, from a finished raw MIME text. */
export function emailMessage(from: string, to: string, raw: string): EmailMessage {
    return new EmailMessage(from, to, raw);
}
