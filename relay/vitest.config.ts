import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// `cloudflare:email` exists only inside workerd. Tests get a stand-in that
// records what a real EmailMessage would carry.
export default defineConfig({
    resolve: {
        alias: {
            "cloudflare:email": fileURLToPath(new URL("test/stubs/cloudflare-email.ts", import.meta.url))
        }
    },
    test: {
        setupFiles: ["test/setup-no-network.ts"]
    }
});
