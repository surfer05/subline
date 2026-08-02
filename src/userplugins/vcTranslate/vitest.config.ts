import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const stub = (name: string) => fileURLToPath(new URL(`tests/stubs/${name}`, import.meta.url));

// index.tsx uses the CLASSIC JSX transform with React pulled in from
// @webpack/common, exactly as Vencord's own build does. Without this the
// toolchain defaults to the automatic runtime and tries to import
// "react/jsx-runtime", which this repo deliberately does not depend on.
const jsx = {
    runtime: "classic",
    pragma: "React.createElement",
    pragmaFrag: "React.Fragment"
} as const;

export default defineConfig({
    test: {
        include: ["tests/**/*.test.ts"],
        environment: "node"
    },
    // Vitest 4 transforms with oxc. On an older vitest (esbuild) this key is
    // ignored and JSX fails to resolve "react/jsx-runtime"; the equivalent
    // there is `esbuild: { jsx: "transform", jsxFactory, jsxFragment }`.
    // Setting both is not an option — vite warns that one is being discarded.
    oxc: { jsx },
    resolve: {
        // The plugin's Vencord-provided imports. These bare specifiers only
        // resolve inside a Vencord checkout, so tests/stubs/ supplies the small
        // surface the plugin actually touches. Everything else in tests/ is
        // pure-logic and unaffected.
        alias: {
            "@api/DataStore": stub("api-datastore.ts"),
            "@api/Settings": stub("api-settings.ts"),
            "@utils/Logger": stub("utils-logger.ts"),
            "@utils/types": stub("utils-types.ts"),
            "@webpack/common": stub("webpack-common.ts")
        }
    }
});
