/**
 * Stand-in for Vencord's `@api/MessagePopover`, aliased in vitest.config.ts.
 *
 * The plugin's declarative `messagePopoverButton` field only ever backs ONE
 * button (PluginManager registers it under the plugin's own name), so the
 * force-quality action is registered directly through this lower-level API
 * instead, under its own identifier — the same real mechanism Vencord uses to
 * back that field, just called a second time. This stub mirrors just enough
 * of `src/api/MessagePopover.tsx`'s surface for that: a map of identifier ->
 * render/icon, keyed exactly as the real module keys it.
 */

export interface StubPopoverButtonItem {
    key?: string;
    label: string;
    icon: unknown;
    message: unknown;
    channel: unknown;
    onClick?: (...args: any[]) => void;
    onContextMenu?: (...args: any[]) => void;
}

export type MessagePopoverButtonFactory = (message: any) => StubPopoverButtonItem | null;

const registry = new Map<string, { render: MessagePopoverButtonFactory; icon: unknown; }>();

export function addMessagePopoverButton(
    identifier: string,
    render: MessagePopoverButtonFactory,
    icon: unknown
): void {
    registry.set(identifier, { render, icon });
}

export function removeMessagePopoverButton(identifier: string): void {
    registry.delete(identifier);
}

/** Test-side only: look up what a plugin registered under `identifier`. */
export function __getPopoverButton(identifier: string) {
    return registry.get(identifier);
}

export function __reset(): void {
    registry.clear();
}
