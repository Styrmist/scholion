import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";

export default defineConfig({
	resolve: {
		alias: {
			obsidian: fileURLToPath(new URL("./test/stubs/obsidian.ts", import.meta.url)),
		},
	},
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
		globals: false,
		clearMocks: true,
	},
});
