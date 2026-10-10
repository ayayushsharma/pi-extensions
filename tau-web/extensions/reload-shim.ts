/**
 * reload-shim — exposes pi's runtime reload as the `/reload` slash command so
 * the tau-web browser UI can trigger it by sending "/reload" as a user
 * message (mirror-server expands leading-slash prompts server-side).
 *
 * The handler runs inside pi's command context, which is the only place
 * ctx.reload() is safe to call. Nothing here opens ports, sockets, or
 * timers; the web UI only needs the command to exist.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("reload", {
		description: "Reload extensions, skills, prompts, themes, and context files",
		handler: async (_args, ctx) => {
			await ctx.reload();
			return;
		},
	});
}
