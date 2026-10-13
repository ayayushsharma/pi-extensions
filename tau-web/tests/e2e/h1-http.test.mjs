// H1 — hub alive: health, root redirect, shell (testing.md §7 P0).
import { startHubStub } from "../hub-stub.mjs";
import { assert, assertPortFree, basePort, fetchJson, PUBLIC_DIR } from "../helpers.mjs";

export const id = "H1";
export const title = "hub alive: /api/health, /→302 /hub/, shell 200";

export async function run() {
  const port = await basePort();
  await assertPortFree(port);
  const hub = await startHubStub({ port, staticDir: PUBLIC_DIR });
  try {
    const h = await fetchJson(`${hub.url}/api/health`);
    assert(h.res.status === 200, `health status ${h.res.status}`);
    assert(h.json?.status === "ok", `health body ${JSON.stringify(h.json)}`);
    assert(h.json?.mode === "hub", `health mode ${JSON.stringify(h.json)}`);

    const root = await fetch(`${hub.url}/`, { redirect: "manual" });
    assert(root.status === 302, `GET / status ${root.status}, want 302`);
    assert(root.headers.get("location") === "/hub/", `GET / location ${root.headers.get("location")}`);

    const shell = await fetch(`${hub.url}/hub/`);
    assert(shell.status === 200, `GET /hub/ status ${shell.status}`);
    const html = await shell.text();
    assert(html.includes("Tau Hub"), "hub shell missing title");
  } finally {
    await hub.close();
  }
}
