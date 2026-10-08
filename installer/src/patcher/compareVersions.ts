/**
 * Ordering for dotted numeric versions ("0.1.10" > "0.1.9"); a non-numeric
 * part counts as 0. One definition, shared by Discord's app folders
 * (locate.ts), the release feed (helper/release.ts) and the installer's
 * downgrade check (flow.ts), so the three cannot disagree.
 */
export function compareVersions(a: string, b: string): number {
    const pa = a.split(".").map(part => Number.parseInt(part, 10) || 0);
    const pb = b.split(".").map(part => Number.parseInt(part, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
}
