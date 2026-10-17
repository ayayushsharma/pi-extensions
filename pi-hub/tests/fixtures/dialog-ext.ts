/**
 * Test extension: exposes /ask and /askselect so the e2e suite can verify the
 * full dialog relay (child extension_ui_request → browser modal → response).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("ask", {
    description: "Ask a confirm dialog through the web UI",
    handler: async (_args, ctx) => {
      const ok = await ctx.ui.confirm("Test dialog", "Proceed with the fixture?");
      ctx.ui.notify(ok ? "DIALOG-YES" : "DIALOG-NO", ok ? "info" : "warning");
    },
  });
  pi.registerCommand("askselect", {
    description: "Ask a select dialog through the web UI",
    handler: async (_args, ctx) => {
      const choice = await ctx.ui.select("Pick one", ["alpha", "beta"]);
      ctx.ui.notify(`DIALOG-${choice || "CANCELLED"}`, "info");
    },
  });
}
