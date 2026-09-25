/** Stand-in for Vencord's `@api/ChatButtons`: a registry keyed like the real one. */
export interface ChatBarProps { channel?: any; [key: string]: unknown; }

export const ChatBarButtonMap = new Map<string, { render: (props: any) => unknown; icon: unknown; }>();

export function addChatBarButton(id: string, render: (props: any) => unknown, icon: unknown): void {
    ChatBarButtonMap.set(id, { render, icon });
}

export function removeChatBarButton(id: string): void {
    ChatBarButtonMap.delete(id);
}
