// X1 — filesystem jails on the real hub (S3/S4/S14), reproduction-first:
//   * /api/file/preview resolves symlinks before jailing (S4)
//   * SVG previews are attachment + sandboxed (S4b)
//   * /api/open refuses symlinked escapes (S4)
//   * /api/files/mkdir jails the *resolved* parent (S14)
//   * WS export_html outputPath is jailed to the session store (S3)
// HTTP + one WS command; no browser, no headless child. Runs wherever `pi`
// is available (Termux included) — SKIPs otherwise.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bootRealHub } from "../hub-real.mjs";
import {
  assert, assertPortFree, basePort, ensureTmp,
  skipCase, postJson,
} from "../helpers.mjs";

export const requires = ["pi"];
export const id = "X1";
export const title = "fs jails: symlinked preview/open/mkdir + export output store jail";

export async function run() {
  ensureTmp();
  // Fixtures live OUTSIDE the repo: configured project roots include the
  // repo tree, so a "forbidden" symlink target under tests/.tmp would still
  // be an allowed root.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tau-e2e-x1-"));
  const root = path.join(dir, "root");       // added via TAU_FS_ROOTS (allowed)
  const outside = path.join(dir, "outside"); // never an allowed root
  const store = path.join(dir, "store");     // PI_CODING_AGENT_SESSION_DIR
  const homeBase = fs.mkdtempSync(path.join(fs.realpathSync(os.homedir()), ".tau-e2e-x1-"));
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.mkdirSync(store, { recursive: true });

  fs.writeFileSync(path.join(outside, "secret.txt"), "TOP-SECRET");
  fs.writeFileSync(path.join(root, "pic.png"), Buffer.from("89504E470D0A1A0A0000000D49484452", "hex"));
  fs.writeFileSync(path.join(root, "notes.txt"), "not an image");
  fs.writeFileSync(path.join(root, "icon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "escape.png"));
  fs.symlinkSync(path.join(dir, "missing-target.txt"), path.join(root, "broken.png"));
  fs.mkdirSync(path.join(root, "dir.png"));
  fs.symlinkSync(outside, path.join(store, "link")); // symlinked parent inside the store
  fs.symlinkSync(outside, path.join(homeBase, "link")); // symlinked parent inside HOME

  const port = await basePort();
  await assertPortFree(port);
  const hub = await bootRealHub({
    port,
    extraEnv: { TAU_FS_ROOTS: root, PI_CODING_AGENT_SESSION_DIR: store },
  });
  try {
    const preview = (p) => fetch(`${hub.url}/api/file/preview?path=${encodeURIComponent(p)}`, { redirect: "manual" });

    // ── S4: allowed image served; escape refused ──
    const ok = await preview(path.join(root, "pic.png"));
    assert(ok.status === 200, `allowed png served, got ${ok.status}`);
    assert(ok.headers.get("content-type") === "image/png", `png content-type, got ${ok.headers.get("content-type")}`);
    assert(ok.headers.get("x-content-type-options") === "nosniff", "preview missing nosniff");
    assert(/sandbox/.test(ok.headers.get("content-security-policy") || ""), "preview missing CSP sandbox");
    assert((await ok.arrayBuffer()).byteLength > 0, "preview body empty");

    const escape = await preview(path.join(root, "escape.png"));
    assert(escape.status === 403, `symlink escape refused, got ${escape.status}`);
    const broken = await preview(path.join(root, "broken.png"));
    assert(broken.status === 404, `dangling symlink 404, got ${broken.status}`);
    const notImage = await preview(path.join(root, "notes.txt"));
    assert(notImage.status === 415, `non-image 415, got ${notImage.status}`);
    const dirPng = await preview(path.join(root, "dir.png"));
    assert(dirPng.status === 404, `directory .png 404, got ${dirPng.status}`);

    // ── S4b: SVG never renders inline on the hub origin ──
    const svg = await preview(path.join(root, "icon.svg"));
    assert(svg.status === 200, `svg served, got ${svg.status}`);
    assert(/^attachment/.test(svg.headers.get("content-disposition") || ""), `svg forced download, got ${svg.headers.get("content-disposition")}`);
    assert(/sandbox/.test(svg.headers.get("content-security-policy") || ""), "svg missing CSP sandbox");

    // ── S4: /api/open refuses escapes *before* any opener runs ──
    const openEscape = await postJson(`${hub.url}/api/open`, { filePath: path.join(root, "escape.png") });
    assert(openEscape.status === 403, `open symlink escape 403, got ${openEscape.status} ${openEscape.text.slice(0, 80)}`);
    const openMissing = await postJson(`${hub.url}/api/open`, { filePath: path.join(root, "nope.txt") });
    assert(openMissing.status === 404, `open missing 404, got ${openMissing.status}`);

    // ── S14: mkdir jails the resolved parent, not just the string ──
    const made = path.join(homeBase, "made");
    const mk1 = await postJson(`${hub.url}/api/files/mkdir`, { path: made });
    assert(mk1.status === 200 && mk1.json?.path === made, `mkdir inside home, got ${mk1.status} ${mk1.text.slice(0, 80)}`);
    const mk2 = await postJson(`${hub.url}/api/files/mkdir`, { path: made });
    assert(mk2.status === 409, `mkdir duplicate 409, got ${mk2.status}`);
    const mk3 = await postJson(`${hub.url}/api/files/mkdir`, { path: path.join(os.tmpdir(), "tau-e2e-x1-nope") });
    assert(mk3.status === 403, `mkdir outside home 403, got ${mk3.status}`);
    const mk4 = await postJson(`${hub.url}/api/files/mkdir`, { path: path.join(homeBase, "link", "nested") });
    assert(mk4.status === 403, `mkdir through symlinked parent 403, got ${mk4.status}`);
    const mk5 = await postJson(`${hub.url}/api/files/mkdir`, { path: path.join(homeBase, "missing", "nested") });
    assert(mk5.status === 400, `mkdir missing parent 400, got ${mk5.status}`);

    // ── S3: export_html outputPath must stay inside the session store ──
    // /api/rpc is the browser's route for local-session commands; the reply
    // is a plain {type:"response"} object.
    const denied = await postJson(`${hub.url}/api/rpc`, { type: "export_html", outputPath: path.join(outside, "evil.html") });
    const err = denied.json?.error || "";
    if (/No context available/.test(err)) skipCase("hub process has no session context to export");
    assert(denied.json?.success === false && /session store/.test(err), `export outside store refused, got ${JSON.stringify(denied.json).slice(0, 140)}`);
    const viaLink = await postJson(`${hub.url}/api/rpc`, { type: "export_html", outputPath: path.join(store, "link", "evil.html") });
    assert(/session store/.test(viaLink.json?.error || ""), `export through symlinked store parent refused, got ${JSON.stringify(viaLink.json).slice(0, 140)}`);
    assert(!fs.existsSync(path.join(outside, "evil.html")), "escape export must not create a file");
  } finally {
    await hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(homeBase, { recursive: true, force: true });
  }
}
