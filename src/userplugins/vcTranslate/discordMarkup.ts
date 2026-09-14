/**
 * Discord embeds mentions and custom emoji in a message's raw `content` as
 * markup carrying a numeric snowflake id, NOT the readable text the reader
 * sees:
 *
 *   <@123> / <@!123>   a user mention        (! is the old nickname form)
 *   <#123>             a channel mention
 *   <@&123>            a role mention
 *   <:name:123>        a custom emoji        (<a:name:123> when animated)
 *   @everyone @here    the two literal mentions — NOT bracketed markup
 *
 * Discord's own client resolves these to "@deniz", "#general", ":blob:" before
 * painting them. Our subtitle shows plain text, so without this the reader sees
 * the raw "<@1237044536178507949>" — and worse, that markup is what gets SENT
 * to the translator, which mistranslates or mangles the id (Google has been
 * seen to reorder/translate the digits, an LLM to invent a name for it).
 *
 * This turns the markup into readable text BEFORE it reaches the translator, so
 * the model both sees and returns a readable token. It is deliberately separate
 * from skip.ts's `stripMarkup`: that erases markup to DECIDE whether anything
 * translatable is left (a bare "<@123>" is nothing to translate and is
 * skipped); this REWRITES markup on the text that is actually translated and
 * rendered. The skip decision must keep running on the raw content, so this is
 * never applied before `shouldSkip`.
 *
 * Design choice: resolve-before-translate (option (a)), not mask-and-restore.
 * A sentinel-and-restore scheme would have to thread a per-message
 * id -> readable-text map from here, through the batcher, every engine, and the
 * result/beacon plumbing, then splice it back into the returned string — a
 * large surface across the whole batch flow for a token the existing prompt
 * rule ("leave usernames and names untranslated") already protects on the LLM
 * tiers. Resolving up front keeps the change to one pure function plus one
 * call site, and the neutral, human-readable tokens it emits ("@deniz",
 * ":blob:") are exactly what a translator handles best.
 */

/**
 * Looks up the readable name for a snowflake id. Returns the name, or
 * `undefined` when the id cannot be resolved (store not loaded, entity gone) —
 * the transform substitutes a neutral placeholder in that case, never the id.
 *
 * Kept as three plain callbacks, with no reference to any Discord store, so the
 * transform is a pure function the tests can drive without a real client. The
 * call site in index.tsx binds these to the live `@webpack/common` stores.
 */
export interface MarkupResolvers {
    /** Display name for a user id: guild nickname if any, else username. */
    user(id: string): string | undefined;
    /** Channel name for a channel id. */
    channel(id: string): string | undefined;
    /** Role name for a role id. */
    role(id: string): string | undefined;
}

/**
 * One pass over the four bracketed forms. A single alternation (rather than four
 * sequential `.replace`s) means a resolved name can never be re-scanned as
 * markup, and the branch is decided by which capture group matched:
 *
 *   1 (a)?    animated flag of a custom emoji (presence ignored; both render the name)
 *   2 (\w+)   custom emoji name
 *   3 (\d+)   custom emoji id      (unused — the id is exactly what we drop)
 *   4 (\d+)   channel id
 *   5 (\d+)   role id
 *   6 (\d+)   user id, matching <@id> and <@!id> alike
 *
 * `<@&id>` is listed before `<@!?id>` so the role form wins the `<@` prefix; the
 * user branch's `!?` never sees the `&` because the role branch consumes it
 * first.
 */
const ENTITY = /<(a)?:(\w+):(\d+)>|<#(\d+)>|<@&(\d+)>|<@!?(\d+)>/g;

/** Neutral, id-free fallbacks — the same words Discord-flavoured text uses. */
const USER_FALLBACK = "user";
const CHANNEL_FALLBACK = "channel";
const ROLE_FALLBACK = "role";

/**
 * Call a resolver defensively and return a usable name or the fallback word.
 * Any throw, a non-string, or a blank/whitespace-only name all collapse to the
 * fallback — the guarantee is that the output NEVER contains the numeric id and
 * this NEVER throws.
 */
function resolveOr(fn: (id: string) => string | undefined, id: string, fallback: string): string {
    let name: string | undefined;
    try {
        name = fn(id);
    } catch {
        name = undefined;
    }
    const trimmed = typeof name === "string" ? name.trim() : "";
    return trimmed.length > 0 ? trimmed : fallback;
}

/**
 * Rewrite Discord entity markup in `text` to readable tokens:
 *   <@id> / <@!id> -> "@" + display name  (fallback "@user")
 *   <#id>          -> "#" + channel name   (fallback "#channel")
 *   <@&id>         -> "@" + role name       (fallback "@role")
 *   <:name:id>     -> ":name:"  (animated <a:name:id> too)
 *
 * `@everyone` / `@here` and every other character are left untouched. Pure and
 * total: it never throws and every unresolved id becomes a neutral placeholder,
 * never the number.
 */
export function renderDiscordMarkup(text: string, resolvers: MarkupResolvers): string {
    if (typeof text !== "string" || text.length === 0) return text;
    if (text.indexOf("<") === -1) return text;   // no possible entity — cheap exit

    return text.replace(
        ENTITY,
        (
            _match: string,
            _animated: string | undefined,
            emojiName: string | undefined,
            _emojiId: string | undefined,
            channelId: string | undefined,
            roleId: string | undefined,
            userId: string | undefined
        ): string => {
            if (emojiName !== undefined) return `:${emojiName}:`;
            if (channelId !== undefined) return "#" + resolveOr(resolvers.channel, channelId, CHANNEL_FALLBACK);
            if (roleId !== undefined) return "@" + resolveOr(resolvers.role, roleId, ROLE_FALLBACK);
            if (userId !== undefined) return "@" + resolveOr(resolvers.user, userId, USER_FALLBACK);
            // Unreachable: every alternative in ENTITY populates one of the
            // branch groups above. Returning the raw match is the safe no-op.
            return _match;
        }
    );
}
