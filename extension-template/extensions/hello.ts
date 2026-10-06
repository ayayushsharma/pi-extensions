/**
 * Hello extension — minimal pi extension template.
 *
 * Copy this package (`cp -r extension-template <my-name>`) and replace this
 * file with your implementation. Pi loads it via jiti, so no build step is
 * needed: `pi --extension ./extensions/hello.ts`
 *
 * Rules:
 * - Keep the factory thin: only register capabilities here.
 * - Start servers/sockets/timers/watchers in `session_start` (or on demand),
 *   and release them in an idempotent `session_shutdown` handler.
 * - Never write to stdout/stderr (it corrupts the fullscreen TUI).
 *   Use ctx.ui.notify() / ctx.ui.setStatus() for user-visible output.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("hello", {
		description: "Show a greeting",
		handler: async (name, ctx) => {
			ctx.ui.notify(`Hello, ${name || "world"}!`, "info");
		},
	});

	pi.on("session_start", async (_event, _ctx) => {
		// Start session-scoped resources here.
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		// Release session-scoped resources here (must be idempotent).
	});
}
