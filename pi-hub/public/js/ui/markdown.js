/**
 * markdown — escape-first, DOM-built renderer. Model output is untrusted, so
 * this never touches innerHTML. Supports: fenced code, headings, ordered and
 * unordered lists, blockquotes, tables, horizontal rules, inline code/strong/
 * em/links. Deliberately small; anything fancier must degrade to text.
 */
import { copyText, el } from "../core/dom.js";

function safeUrl(url) {
  try {
    const u = new URL(url, location.origin);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

export function inline(text) {
  const out = document.createDocumentFragment();
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(__[^_]+__)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  for (let m; (m = re.exec(text)); ) {
    if (m.index > last) out.append(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith("`")) out.append(el("code", { text: token.slice(1, -1) }));
    else if (token.startsWith("**") || token.startsWith("__")) out.append(el("strong", { text: token.slice(2, -2) }));
    else if (token.startsWith("*")) out.append(el("em", { text: token.slice(1, -1) }));
    else {
      const label = token.slice(1, token.indexOf("]"));
      const href = safeUrl(token.slice(token.indexOf("](") + 2, -1));
      out.append(href ? el("a", { href, target: "_blank", rel: "noreferrer", text: label }) : label);
    }
    last = m.index + token.length;
  }
  if (last < text.length) out.append(text.slice(last));
  return out;
}

function tableFrom(lines) {
  const cells = (line) =>
    line
      .replace(/^\s*\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map((c) => c.trim());
  const table = el("table");
  const [head, , ...rows] = lines;
  const thead = el("thead");
  const hr = el("tr");
  for (const c of cells(head)) hr.append(el("th", {}, inline(c)));
  thead.append(hr);
  table.append(thead);
  const tbody = el("tbody");
  for (const row of rows) {
    const tr = el("tr");
    for (const c of cells(row)) tr.append(el("td", {}, inline(c)));
    tbody.append(tr);
  }
  table.append(tbody);
  return table;
}

export function renderMarkdown(src) {
  const frag = document.createDocumentFragment();
  const lines = String(src ?? "").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fence = /^```(\w+)?\s*$/.exec(line);
    if (fence) {
      const body = [];
      const lang = fence[1] || "";
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      const codeText = body.join("\n");
      frag.append(
        el(
          "div",
          { class: "code-wrap" },
          el(
            "div",
            { class: "code-head" },
            el("span", { class: "code-lang", text: lang || "code" }),
            el("button", {
              class: "code-copy", type: "button", text: "Copy",
              title: "Copy code to clipboard",
              "aria-label": "Copy code to clipboard",
              onclick: () => copyText(codeText),
            }),
          ),
          el("pre", { class: "code-block" }, el("code", { text: codeText })),
        ),
      );
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1] || "")) {
      const block = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) block.push(lines[i++]);
      try {
        frag.append(tableFrom(block));
      } catch {
        for (const l of block) frag.append(el("p", {}, inline(l)));
      }
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      frag.append(el(`h${heading[1].length + 1}`, {}, inline(heading[2])));
      i++;
      continue;
    }

    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const list = el(ordered ? "ol" : "ul");
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        list.append(el("li", {}, inline(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ""))));
        i++;
      }
      frag.append(list);
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ""));
      frag.append(el("blockquote", {}, inline(quote.join("\n"))));
      continue;
    }

    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      frag.append(el("hr"));
      i++;
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const para = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(```|#{1,4}\s|>|\s*([-*]|\d+\.)\s|\s*\|)/.test(lines[i])
    ) {
      para.push(lines[i++]);
    }
    frag.append(el("p", {}, inline(para.join("\n"))));
  }
  return frag;
}
