/** Stand-in for Vencord's `@api/MessageAccessories`: a registry keyed like the real one. */
export const accessories = new Map<string, { render: (props: any) => unknown; position?: number; }>();

export function addMessageAccessory(identifier: string, render: (props: any) => unknown, position?: number): void {
    accessories.set(identifier, { render, position });
}

export function removeMessageAccessory(identifier: string): void {
    accessories.delete(identifier);
}
