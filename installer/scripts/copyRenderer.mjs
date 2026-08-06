/**
 * Copy the renderer's non-TypeScript assets into `dist/`.
 *
 * `tsc` emits `renderer.js` beside where its source was, but knows nothing about
 * `index.html`, and the main process loads the HTML by path. Two lines of copy
 * beats adding a bundler to a project whose renderer is one file.
 */

import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, "..", "src", "renderer");
const to = join(here, "..", "dist", "renderer");

mkdirSync(to, { recursive: true });
for (const name of readdirSync(from)) {
    if (name.endsWith(".ts")) continue;
    cpSync(join(from, name), join(to, name), { recursive: true });
}
console.log(`Copied renderer assets to ${to}`);
