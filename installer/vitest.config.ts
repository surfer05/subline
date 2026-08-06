import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["tests/**/*.test.ts"],
        environment: "node",
        // Every test builds its own temp-directory Discord fixture and the
        // patcher does real renames on it. Parallel files are fine (each has
        // its own mkdtemp root) but tests within a file share a fixture, so
        // they must not interleave.
        sequence: { concurrent: false }
    }
});
