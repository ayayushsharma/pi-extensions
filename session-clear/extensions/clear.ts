/**
 * Clear extension — true session wipe.
 *
 * `/new` starts a new session but leaves the old session file on disk
 * (resumable, still listed in the picker). `/clear` instead deletes the
 * current session file and starts fresh, so no history survives.
 *
 * Safety:
 * - Asks for confirmation (skip with `/clear --force` / `/clear -f`).
 * - Refuses to delete in non-interactive modes unless `--force` is given.
 * - Captures the old file path before switching, deletes only after the
 *   new session is active — so a cancelled switch never loses history.
 * - Never writes to stdout/stderr (TUI corruption); all output via notify.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { unlink } from "node:fs/promises";
import * as path from "node:path";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("clear", {
		description: "Delete the current session file and start fresh (history fully erased)",
		handler: async (args, ctx) => {
			const force = /(^|\s)(--force|-f)(\s|$)/.test(args.trim());

			// Plain data only — the handler ctx is invalid after the switch.
			const oldFile = ctx.sessionManager.getSessionFile();
			const oldLabel = oldFile ? path.basename(oldFile) : "ephemeral session";

			if (!force) {
				if (!ctx.hasUI) {
					ctx.ui.notify("Refusing to delete session in non-interactive mode without --force.", "error");
					return;
				}
				const ok = await ctx.ui.confirm(
					"Delete session?",
					oldFile
						? `Permanently delete this session and start fresh?\n${oldLabel}\nThis cannot be undone.`
						: "Start a fresh session? (current session is ephemeral — nothing on disk to delete)",
				);
				if (!ok) {
					ctx.ui.notify("Clear cancelled — session untouched.", "info");
					return;
				}
			}

			await ctx.waitForIdle();
			await ctx.newSession({
				withSession: async (newCtx) => {
					const newFile = newCtx.sessionManager.getSessionFile();
					if (oldFile && oldFile !== newFile) {
						try {
							await unlink(oldFile);
							newCtx.ui.notify(`Deleted ${oldLabel} — started fresh.`, "info");
						} catch (err) {
							const reason = err instanceof Error ? err.message : String(err);
							newCtx.ui.notify(`Started fresh, but could not delete ${oldLabel}: ${reason}`, "warning");
						}
					} else if (!oldFile) {
						newCtx.ui.notify("Started fresh. (Previous session was ephemeral — nothing on disk.)", "info");
					} else {
						newCtx.ui.notify("Started fresh.", "info");
					}
				},
			});
		},
	});
}
