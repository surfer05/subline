/** Stand-in for Vencord's IndexedDB-backed `@api/DataStore`. */
const mem = new Map<string, unknown>();

/**
 * Every key a test run has written, in order, including repeats.
 *
 * Exists for one claim the map alone cannot support: the install id (see
 * taste.ts) must be generated and persisted ONCE, ever. Reading the map back
 * proves only that a value is there, not that a second press did not quietly
 * overwrite it with a different id.
 */
export const writes: string[] = [];

/**
 * THE DEFAULT PLAN FOR TESTS: an install that owns Automatic and AI, with an
 * answer that never runs out. There is no free tier (entitlement.ts), so an
 * empty store would be an install that translates nothing, and every test of
 * translation itself would first have to activate. Tests of the plans
 * themselves set their own (`setEntitlementForTest`) or clear it
 * (`clearEntitlementForTest`).
 */
export const DEFAULT_ENTITLEMENT = { automatic: true, ai: true, tokenExpiresAt: Number.MAX_SAFE_INTEGER, checkedAt: 0 };
const ENTITLEMENT_KEY = "VcTranslate_entitlement";

function seed(): void {
    mem.set(ENTITLEMENT_KEY, { ...DEFAULT_ENTITLEMENT });
}
seed();

/** A read a test holds until it says so (see __holdGet). */
const held = new Map<string, Promise<void>>();

/** Make reads of `key` wait for `until` (to open a start() window in a test). */
export function __holdGet(key: string, until: Promise<void>): void {
    held.set(key, until);
}

export async function get<T>(key: string): Promise<T | undefined> {
    const wait = held.get(key);
    if (wait !== undefined) await wait;
    return mem.get(key) as T | undefined;
}

export async function set(key: string, value: unknown): Promise<void> {
    writes.push(key);
    if (value === undefined) mem.delete(key);
    else mem.set(key, value);
}

/** What the next start() reads as this install's plan. */
export function setEntitlementForTest(value: Record<string, unknown>): void {
    mem.set(ENTITLEMENT_KEY, value);
}

/** An install that owns nothing (as far as the stored answer says). */
export function clearEntitlementForTest(): void {
    mem.delete(ENTITLEMENT_KEY);
}

export function __reset(): void {
    mem.clear();
    held.clear();
    writes.length = 0;
    seed();
}
