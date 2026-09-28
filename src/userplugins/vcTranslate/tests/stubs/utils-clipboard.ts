/** Stand-in for Vencord's `@utils/clipboard`, aliased in vitest.config.ts. Records what was copied. */
export const copied: string[] = [];

export async function copyToClipboard(text: string): Promise<void> {
    copied.push(text);
}

export function __resetClipboard(): void {
    copied.length = 0;
}
