/**
 * files — the server file panel and read-only viewer. The only way content
 * leaves the panel is "Add to prompt" (an @path reference) — never an edit.
 */
import { fileContent, listDir, previewUrl, downloadUrl } from "../core/api.js";
import { el, show, copyText, toast, basename } from "../core/dom.js";
import { icon } from "../core/icons.js";

const TEXT_EXT = /\.(txt|md|markdown|json|jsonl|js|mjs|cjs|ts|tsx|jsx|css|html|htm|xml|yml|yaml|toml|ini|cfg|conf|sh|bash|zsh|py|rb|go|rs|java|c|h|cpp|hpp|swift|kt|sql|log|csv)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;

export function createFiles(refs, actions) {
  let currentPath = "";
  let root = ""; // the session project root — the panel's "up" boundary
  let session = null;

  refs.close.append(icon("x", 15));
  refs.up.append(icon("chevron-left", 15));
  refs.finder.append(icon("copy", 14));
  refs.finder.title = "Copy path";

  async function open(path) {
    if (!path) return;
    try {
      const out = await listDir(path);
      currentPath = out.path;
      if (!root) root = out.path;
      updateUpButton();
      refs.path.textContent = out.path;
      refs.panelTitle.textContent = basename(out.path) || out.path;
      refs.list.replaceChildren();
      const dirs = out.entries.filter((e) => e.type === "dir").sort((a, b) => a.name.localeCompare(b.name));
      const files = out.entries.filter((e) => e.type !== "dir").sort((a, b) => a.name.localeCompare(b.name));
      if (!dirs.length && !files.length) refs.list.append(el("div", { class: "sb-empty", text: "Empty directory" }));
      for (const entry of dirs) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        refs.list.append(
          el("button", { type: "button", class: "file-row dir", onclick: () => open(`${out.path}/${entry.name}`) },
            icon("folder", 14),
            el("span", { class: "fname", text: entry.name }),
          ),
        );
      }
      for (const entry of files.slice(0, 500)) {
        const isImage = IMAGE_EXT.test(entry.name);
        const row = el("button", {
          type: "button",
          class: "file-row",
          onclick: () => view(`${out.path}/${entry.name}`),
        },
          icon(isImage ? "image" : TEXT_EXT.test(entry.name) ? "file-code" : "file", 14),
          el("span", { class: "fname", text: entry.name }),
          el("button", {
            type: "button",
            class: "icon-btn file-add",
            title: "Add to prompt",
            "aria-label": `Add ${entry.name} to prompt`,
            onclick: (e) => { e.stopPropagation(); actions.addToPrompt(`${out.path}/${entry.name}`); },
          }, icon("plus", 12)),
        );
        refs.list.append(row);
      }
      show(refs.panel, true);
    } catch (e) {
      toast(e.message, { kind: "error" });
    }
  }

  async function view(path) {
    try {
      if (IMAGE_EXT.test(path)) {
        refs.body.replaceChildren(el("img", { src: previewUrl(path, session), alt: basename(path) }));
        refs.body.dataset.path = path;
        refs.title.textContent = basename(path);
        refs.download.href = downloadUrl(path);
        show(refs.download, true);
      } else {
        const out = await fileContent(path, session);
        if (out.binary) {
          refs.body.textContent = `Binary file (${Math.round((out.size || 0) / 1024)} KB)`;
          show(refs.download, true);
          refs.download.href = downloadUrl(path);
        } else {
          refs.body.textContent = out.text + (out.truncated ? "\n\n… truncated by the server" : "");
          show(refs.download, false);
        }
        refs.body.dataset.path = out.path;
        refs.title.textContent = basename(out.path);
      }
      show(refs.viewer, true);
    } catch (e) {
      toast(e.message, { kind: "error" });
    }
  }

  function parentOf(p) {
    const parts = String(p).split(/[\\/]/).filter(Boolean);
    parts.pop();
    return parts.length ? `/${parts.join("/")}` : "/";
  }
  /* "Up" is disabled exactly at the session project root. It used to consult
     the server's jail roots (HOME + every session cwd) fetched asynchronously
     after the first listing: until that reply landed the button was enabled,
     and a root with no nested roots disabled it — so the same directory could
     flip state on its own. A plain comparison with the root this panel opened
     at is deterministic and matches what the panel is for. */
  function atProjectRoot() {
    return !currentPath || !root || currentPath === root;
  }
  function updateUpButton() {
    const disabled = atProjectRoot();
    refs.up.disabled = disabled;
    refs.up.title = disabled ? "Already at the project root" : "Parent directory";
  }

  refs.close.addEventListener("click", () => show(refs.panel, false));
  refs.up.addEventListener("click", () => open(parentOf(currentPath)));
  refs.finder.addEventListener("click", () => copyText(currentPath));
  refs.viewerClose.addEventListener("click", () => show(refs.viewer, false));
  refs.viewer.addEventListener("click", (e) => {
    if (e.target === refs.viewer) show(refs.viewer, false);
  });
  refs.viewerAdd.addEventListener("click", () => {
    const path = refs.body.dataset.path;
    if (path) actions.addToPrompt(path);
    show(refs.viewer, false);
  });

  return {
    async show(sessionCwd, sessionRef) {
      session = sessionRef || null;
      if (!sessionCwd) {
        toast("No session directory to browse yet", { kind: "error" });
        return;
      }
      root = "";
      await open(sessionCwd);
    },
    open,
    view,
    toggle(sessionCwd, sessionRef) {
      return refs.panel.classList.contains("hidden") ? this.show(sessionCwd, sessionRef) : show(refs.panel, false);
    },
    isOpen: () => !refs.panel.classList.contains("hidden"),
  };
}
