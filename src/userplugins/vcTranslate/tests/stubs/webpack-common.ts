/**
 * Stand-in for Vencord's `@webpack/common`, aliased in vitest.config.ts.
 *
 * Everything the plugin touches, and nothing else. State lives in exported
 * mutable containers so a test can drive Discord's side of the conversation
 * (dispatch a Flux event, populate a channel's message history) and inspect the
 * results (which toasts were shown).
 */

/* ---------------------------------------------------------------- React --- */

/**
 * Just enough React to call a function component directly and look at what it
 * returned. `createElement` produces a plain inspectable object rather than a
 * real element — the accessory's contract under test is "renders nothing" vs.
 * "renders the failure marker" vs. "renders the translation", which is
 * observable without a renderer.
 */
export const React = {
    useReducer<S>(_reducer: unknown, initial: S): [S, () => void] {
        return [initial, () => { }];
    },
    useEffect(_fn: unknown, _deps?: unknown): void { },
    createElement(type: unknown, props: unknown, ...children: unknown[]) {
        return { type, props, children };
    },
    Fragment: "Fragment"
};

/* ---------------------------------------------------------------- Toasts -- */

export interface StubToast { id: string; type: string; message: string; }

export const shownToasts: StubToast[] = [];

let toastSeq = 0;

export const Toasts = {
    Type: { FAILURE: "FAILURE", SUCCESS: "SUCCESS", MESSAGE: "MESSAGE" },
    genId: () => `toast-${++toastSeq}`,
    show(toast: StubToast): void { shownToasts.push(toast); }
};

/* ------------------------------------------------------------- UserStore -- */

export const stubCurrentUser: { id: string } | undefined = { id: "me" };

/** userId -> display fields, so a test can drive `<@id>` mention resolution. */
export const stubUsers = new Map<string, { username?: string; globalName?: string | null }>();

export function __stubSetUser(id: string, fields: { username?: string; globalName?: string | null }): void {
    stubUsers.set(id, fields);
}

export const UserStore = {
    getCurrentUser: () => stubCurrentUser,
    getUser: (id: string) => stubUsers.get(id)
};

/* ----------------------------------------------------- GuildMemberStore -- */

/** `${guildId}:${userId}` -> nickname, for `<@id>` resolving to a guild nick. */
export const stubNicks = new Map<string, string>();

export function __stubSetNick(guildId: string, userId: string, nick: string): void {
    stubNicks.set(`${guildId}:${userId}`, nick);
}

export const GuildMemberStore = {
    getNick: (guildId: string, userId: string) => stubNicks.get(`${guildId}:${userId}`) ?? null
};

/* ------------------------------------------------------- GuildRoleStore -- */

/** `${guildId}:${roleId}` -> role, for `<@&id>` resolving to a role name. */
export const stubRoles = new Map<string, { name?: string }>();

export function __stubSetRole(guildId: string, roleId: string, name: string): void {
    stubRoles.set(`${guildId}:${roleId}`, { name });
}

export const GuildRoleStore = {
    getRole: (guildId: string, roleId: string) => stubRoles.get(`${guildId}:${roleId}`)
};

/* ---------------------------------------------------------- MessageStore -- */

/** channelId -> the messages `MessageStore.getMessages(id).toArray()` returns. */
export const stubMessages = new Map<string, unknown[]>();

export const MessageStore = {
    getMessages(channelId: string) {
        const arr = stubMessages.get(channelId);
        return arr ? { toArray: () => arr } : undefined;
    }
};

/* ---------------------------------------------------------- ChannelStore -- */

// Channels carry a guild_id; DMs and group DMs do not. The plugin relies on
// that distinction to keep globalAuto from translating private conversations,
// so the stub has to model it or that guard is untestable.
const dmChannels = new Set<string>();

/** channelId -> name, for `<#id>` mention resolution. Optional; absent = no name. */
const channelNames = new Map<string, string>();

export function __stubMarkAsDm(channelId: string): void {
    dmChannels.add(channelId);
}

export function __stubSetChannelName(channelId: string, name: string): void {
    channelNames.set(channelId, name);
}

export const ChannelStore = {
    getChannel: (id: string) =>
        dmChannels.has(id)
            ? { id, name: channelNames.get(id) }
            : { id, guild_id: "stub-guild", name: channelNames.get(id) }
};

/* -------------------------------------------------- SelectedChannelStore -- */

let selectedChannelId: string | null = null;

export function __stubSetSelectedChannel(id: string | null): void {
    selectedChannelId = id;
}

export const SelectedChannelStore = {
    getChannelId: () => selectedChannelId
};

/* --------------------------------------------------------- FluxDispatcher -- */

type Handler = (payload: any) => void;

const handlers = new Map<string, Set<Handler>>();

export const FluxDispatcher = {
    subscribe(event: string, fn: Handler): void {
        let s = handlers.get(event);
        if (!s) handlers.set(event, s = new Set());
        s.add(fn);
    },
    unsubscribe(event: string, fn: Handler): void {
        handlers.get(event)?.delete(fn);
    },
    /** Test-side only: Discord's real dispatcher does far more than this. */
    dispatch(event: string, payload: unknown): void {
        for (const fn of [...(handlers.get(event) ?? [])]) fn(payload);
    },
    /** True when the plugin is currently subscribed to `event`. */
    isSubscribed(event: string): boolean {
        return (handlers.get(event)?.size ?? 0) > 0;
    }
};

/* ----------------------------------------------------------- LocaleStore -- */

/** Mutable so a test can check the target-language default follows it. */
export const LocaleStore = { locale: "en-US" };

/* ------------------------------------------------------------------------- */

export function __resetWebpackCommon(): void {
    dmChannels.clear();
    channelNames.clear();
    stubUsers.clear();
    stubNicks.clear();
    stubRoles.clear();
    selectedChannelId = null;
    shownToasts.length = 0;
    stubMessages.clear();
    handlers.clear();
    LocaleStore.locale = "en-US";
}
