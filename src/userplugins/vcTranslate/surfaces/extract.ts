/**
 * Which texts on each surface get a translation, read from Discord's own data
 * (the message record, the presence and profile stores, the channel record).
 *
 * Pure functions over loosely typed input: Discord's shapes drift, so every
 * field is read defensively and a missing one simply yields no text. Nothing
 * here ever returns a username, display name, nickname, or a server or
 * channel NAME. Thread and forum post titles are the one exception the
 * product asks for: a thread's name is its title.
 */

export type SurfaceKind =
    | "embed-title" | "embed-description" | "embed-field"
    | "poll-question" | "poll-answer"
    | "reply" | "forward"
    | "status" | "bio"
    | "topic" | "thread-title" | "forum-tag" | "event"
    | "voice-status" | "stage-topic" | "rule" | "guidelines" | "onboarding";

export interface SurfaceText {
    kind: SurfaceKind;
    /** A short plain label, shown before the translation where it helps. */
    label: string;
    text: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function push(out: SurfaceText[], kind: SurfaceKind, label: string, value: unknown): void {
    const text = str(value).trim();
    if (text !== "") out.push({ kind, label, text });
}

/** Embed title, description and fields. `rawTitle` etc. are the message record's names. */
export function embedTexts(embeds: unknown): SurfaceText[] {
    const out: SurfaceText[] = [];
    if (!Array.isArray(embeds)) return out;
    for (const e of embeds) {
        if (e === null || typeof e !== "object") continue;
        const embed = e as Record<string, unknown>;
        push(out, "embed-title", "Embed", embed.rawTitle ?? embed.title);
        push(out, "embed-description", "Embed", embed.rawDescription ?? embed.description);
        if (Array.isArray(embed.fields)) {
            for (const f of embed.fields) {
                if (f === null || typeof f !== "object") continue;
                const field = f as Record<string, unknown>;
                push(out, "embed-field", "Embed", field.rawName ?? field.name);
                push(out, "embed-field", "Embed", field.rawValue ?? field.value);
            }
        }
    }
    return out;
}

/** Poll question and each answer. Accepts the API's snake_case and a camelCase record. */
export function pollTexts(poll: unknown): SurfaceText[] {
    const out: SurfaceText[] = [];
    if (poll === null || typeof poll !== "object") return out;
    const p = poll as Record<string, any>;
    push(out, "poll-question", "Poll", p.question?.text);
    if (Array.isArray(p.answers)) {
        for (const a of p.answers) push(out, "poll-answer", "Poll", (a?.poll_media ?? a?.pollMedia)?.text);
    }
    return out;
}

/** Forwarded message snapshots: their text and their embeds. */
export function forwardTexts(snapshots: unknown): SurfaceText[] {
    const out: SurfaceText[] = [];
    if (!Array.isArray(snapshots)) return out;
    for (const s of snapshots) {
        const m = (s as any)?.message;
        if (m === null || typeof m !== "object") continue;
        push(out, "forward", "Forwarded", m.content);
        for (const e of embedTexts(m.embeds)) out.push({ ...e, label: "Forwarded" });
    }
    return out;
}

/** Discord's REPLY message type. */
export const REPLY_MESSAGE_TYPE = 19;

/** The referenced message a reply quotes, when this message is a reply. */
export function replyReference(message: any): { channelId: string; messageId: string } | null {
    if (message?.type !== REPLY_MESSAGE_TYPE) return null;
    const ref = message.messageReference;
    if (typeof ref?.channel_id !== "string" || typeof ref?.message_id !== "string") return null;
    return { channelId: ref.channel_id, messageId: ref.message_id };
}

/** Everything a message carries beyond its own text: embeds, poll, forwards. */
export function messageSurfaceTexts(message: any): SurfaceText[] {
    if (message === null || typeof message !== "object") return [];
    return [
        ...embedTexts(message.embeds),
        ...pollTexts(message.poll),
        ...forwardTexts(message.messageSnapshots)
    ];
}

/** Discord's CUSTOM_STATUS activity type. */
export const CUSTOM_STATUS_ACTIVITY = 4;

/** The custom status text among a user's activities (never the emoji, never a game). */
export function customStatusText(activities: unknown): string {
    if (!Array.isArray(activities)) return "";
    const status = activities.find(a => a?.type === CUSTOM_STATUS_ACTIVITY);
    return str(status?.state).trim();
}

/** An onboarding prompt's own text: its question, and each option's title and description. */
export function onboardingPromptTexts(prompt: unknown): SurfaceText[] {
    const out: SurfaceText[] = [];
    if (prompt === null || typeof prompt !== "object") return out;
    const p = prompt as Record<string, any>;
    push(out, "onboarding", "Question", p.title);
    if (Array.isArray(p.options)) {
        for (const o of p.options) {
            push(out, "onboarding", "Option", o?.title);
            push(out, "onboarding", "Option", o?.description);
        }
    }
    return out;
}

/** The names of the tags applied to a forum post, looked up on its parent forum. */
export function appliedTagNames(channel: any, parent: any): string[] {
    const tags: unknown[] = Array.isArray(parent?.availableTags) ? parent.availableTags : [];
    const applied: unknown[] = Array.isArray(channel?.appliedTags) ? channel.appliedTags : [];
    const names: string[] = [];
    for (const id of applied) {
        const name = str((tags.find(t => (t as any)?.id === id) as any)?.name).trim();
        if (name !== "") names.push(name);
    }
    return names;
}
