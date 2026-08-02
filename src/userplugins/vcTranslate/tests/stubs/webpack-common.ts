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

export const UserStore = {
    getCurrentUser: () => stubCurrentUser
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

export function __stubMarkAsDm(channelId: string): void {
    dmChannels.add(channelId);
}

export const ChannelStore = {
    getChannel: (id: string) =>
        dmChannels.has(id) ? { id } : { id, guild_id: "stub-guild" }
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
    selectedChannelId = null;
    shownToasts.length = 0;
    stubMessages.clear();
    handlers.clear();
    LocaleStore.locale = "en-US";
}
