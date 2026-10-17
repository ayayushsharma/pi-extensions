// markdown — escape first, then a small block/inline pass building DOM nodes.
// Never innerHTML: model output is untrusted.
import { el } from "../core/dom.js";

function safeUrl(url) {
  try {
    const u = new URL(url, location.origin);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

function inline(text) {
  const frag = document.createDocumentFragment();
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  for (let m; (m = re.exec(text)); ) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith("`")) frag.append(el("code", { text: token.slice(1, -1) }));
    else if (token.startsWith("**")) frag.append(el("strong", { text: token.slice(2, -2) }));
    else if (token.startsWith("*")) frag.append(el("em", { text: token.slice(1, -1) }));
    else {
      const label = token.slice(1, token.indexOf("]"));
      const href = safeUrl(token.slice(token.indexOf("](") + 2, -1));
      frag.append(href ? el("a", { href, target: "_blank", rel: "noreferrer", text: label }) : label);
    }
    last = m.index + token.length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

export function renderMarkdown(src) {
  const frag = document.createDocumentFragment();
  const lines = String(src ?? "").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      frag.append(el("pre", { class: "code" }, el("code", { text: body.join("\n") })));
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      frag.append(el(`h${heading[1].length + 2}`, {}, inline(heading[2])));
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
    if (!line.trim()) {
      i++;
      continue;
    }
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|>|\s*([-*]|\d+\.)\s)/.test(lines[i])) {
      para.push(lines[i++]);
    }
    frag.append(el("p", {}, inline(para.join("\n"))));
  }
  return frag;
}
