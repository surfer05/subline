/** Types for patchCheckReport.mjs, so the installer's tests typecheck against it. */

export const CHANNELS: string[];
export const ISSUE_TITLE: string;

export interface ChannelResult {
    channel: string;
    state: "pass" | "fail" | "error";
    failing: Array<{ plugin: string; find: string; why: string; }>;
    error: string;
    checked: number;
}

export function channelResult(dir: string, channel: string): ChannelResult;
export function renderReport(results: ChannelResult[], options?: { runUrl?: string; date?: string; }): { failed: boolean; markdown: string; };
