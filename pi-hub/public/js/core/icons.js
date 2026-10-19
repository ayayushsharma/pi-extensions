/**
 * icons — a small inline SVG set (stroke-based, 24-unit viewBox) drawn for
 * pi-hub. Static trusted markup only: `innerHTML` here never touches server
 * or model data.
 */
const P = {
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  "chevron-down": '<path d="m6 9 6 6 6-6"/>',
  "chevron-left": '<path d="m15 18-6-6 6-6"/>',
  "chevron-right": '<path d="m9 18 6-6-6-6"/>',
  "arrow-up": '<path d="M12 19V5M5 12l7-7 7 7"/>',
  "arrow-left": '<path d="M19 12H5m7 7-7-7 7-7"/>',
  back: '<path d="M19 12H5m7 7-7-7 7-7"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/>',
  square: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  gear: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  palette:
    '<circle cx="13.5" cy="6.5" r=".8"/><circle cx="17.5" cy="10.5" r=".8"/><circle cx="8.5" cy="7.5" r=".8"/><circle cx="6.5" cy="12.5" r=".8"/><path d="M12 2a10 10 0 1 0 0 20c1.2 0 2-.9 2-2 0-.5-.2-1-.5-1.4-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h2.3c2.3 0 4.2-1.9 4.2-4.2C21.5 6.2 17.3 2 12 2Z"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/>',
  server: '<rect x="2" y="3" width="20" height="7" rx="2"/><rect x="2" y="14" width="20" height="7" rx="2"/><path d="M6 6.5h.01M6 17.5h.01"/>',
  terminal: '<path d="m7 8 4 4-4 4"/><path d="M13 16h4"/>',
  commands: '<rect x="3" y="4" width="18" height="16" rx="4"/><path d="m14 8.5-4 7"/>',
  tabs: '<rect x="3" y="8" width="12" height="12" rx="2"/><path d="M8 8V6a3 3 0 0 1 3-3h7a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3h-3"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  star: '<path d="m12 3 2.7 5.6 6.3.9-4.5 4.4 1 6.1-5.5-2.9L6.5 20l1-6.1L3 9.5l6.3-.9Z"/>',
  "star-outline": '<path d="m12 3 2.7 5.6 6.3.9-4.5 4.4 1 6.1-5.5-2.9L6.5 20l1-6.1L3 9.5l6.3-.9Z" fill="none"/>',
  // Filled variant: `star` alone is still a stroke glyph (fill:none on the
  // svg), so a "favourited" star looked hollow and read as "add to favourites".
  starFill: '<path fill="currentColor" stroke="none" d="m12 3 2.7 5.6 6.3.9-4.5 4.4 1 6.1-5.5-2.9L6.5 20l1-6.1L3 9.5l6.3-.9Z"/>',
  pencil: '<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/>',
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  branch: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7"/><path d="M18 10.5A6 6 0 0 1 12 16H8.5"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  check: '<path d="m4 12 5 5L20 6"/>',
  alert: '<path d="M12 3 2 20h20Z"/><path d="M12 10v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  play: '<path d="M7 4.5v15l12-7.5Z"/>',
  eye: '<path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="2.8"/>',
  home: '<path d="m3 10 9-7 9 7v9a2 2 0 0 1-2 2h-4v-6h-6v6H5a2 2 0 0 1-2-2Z"/>',
  logout: '<path d="M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3"/><path d="m15 16 5-4-5-4"/><path d="M20 12H9"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/>',
  "file-code": '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="m10 13-2 2 2 2M14 13l2 2-2 2"/>',
  volume: '<path d="M11 5 6 9H3v6h3l5 4Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  "message": '<path d="M21 12a8.5 8.5 0 0 1-8.5 8.5H4L3 22l1.5-4.5A8.5 8.5 0 1 1 21 12Z"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8Z"/>',
  "dots": '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1l3.4 3.4"/>',
};

export function icon(name, size = 16) {
  const span = document.createElement("span");
  span.className = "icon";
  span.style.width = `${size}px`;
  span.style.height = `${size}px`;
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${P[name] || ""}</svg>`;
  return span;
}

/* ── pi-hub mark ──────────────────────────────────────────────────────
 * Five marks inspired by the pi glyph, none of them a copy of it. The
 * badge is drawn with `currentColor`, the π in the badge's negative space,
 * so a theme switch recolours the logo with everything else. */
const MARKS = {
  /** pi: bare lettermark — the Greek π with a thin orbit, no badge */
  pi: {
    body: "",
    ink: '<ellipse cx="12" cy="12" rx="9.2" ry="3.6" fill="none" transform="rotate(-26 12 12)" ' +
      'style="stroke:var(--accent);stroke-opacity:.38" stroke-width="1.05"/>' +
      '<path d="M6.8 9.3h10.4M9.4 9.3v5.7M14.6 9.3v5.7" fill="none" ' +
      'style="stroke:var(--accent)" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>',
  },
  /** knockout: heavier π, small dot tucked into the corner */
  knockout: {
    body: '<rect x="1.5" y="1.5" width="21" height="21" rx="7" style="fill:var(--accent)"/>',
    ink: '<g fill="none" style="stroke:var(--on-accent)" stroke-width="2.4" stroke-linecap="round"><path d="M7.4 9.2h9.2M9.2 9.2v6.1M14.8 9.2v6.1"/></g>' +
      '<circle cx="18.6" cy="18.4" r="1.5" style="fill:var(--on-accent)" opacity=".75"/>',
  },
  /** badge: thin ring, dot sitting on the ring */
  badge: {
    body: '<circle cx="12" cy="12" r="10" fill="none" style="stroke:var(--accent)" stroke-width="1.7"/>' +
      '<circle cx="17.6" cy="18.4" r="2.4" style="fill:var(--accent)"/>',
    ink: '<g fill="none" style="stroke:var(--accent)" stroke-width="2" stroke-linecap="round"><path d="M8 9.6h8M9.6 9.6v5.2M14.4 9.6v5.2"/></g>',
  },
  /** nodes: the π's strokes end in hub nodes */
  nodes: {
    body: '<rect x="1.5" y="1.5" width="21" height="21" rx="6.5" style="fill:var(--accent)"/>',
    ink: '<g fill="none" style="stroke:var(--on-accent)" stroke-width="1.7" stroke-linecap="round"><path d="M7.3 9.6h9.4M9.2 9.6v5.6M14.8 9.6v5.6"/></g>' +
      '<g style="fill:var(--on-accent)"><circle cx="7.3" cy="9.6" r="1.6"/><circle cx="16.7" cy="9.6" r="1.6"/>' +
      '<circle cx="9.2" cy="15.2" r="1.6"/><circle cx="14.8" cy="15.2" r="1.6"/></g>',
  },
  /** node: a hub node above the π */
  node: {
    body: '<rect x="1.5" y="1.5" width="21" height="21" rx="6.5" style="fill:var(--accent)"/>',
    ink: '<circle cx="12" cy="6.6" r="1.5" style="fill:var(--on-accent)"/>' +
      '<path d="M12 8.1v1.1" style="stroke:var(--on-accent)" stroke-width="1.4" stroke-linecap="round"/>' +
      '<g fill="none" style="stroke:var(--on-accent)" stroke-width="1.9" stroke-linecap="round"><path d="M8 9.6h8M9.5 9.6v6.2M14.5 9.6v6.2"/></g>',
  },
};

/** default mark; switch this one string to pick another */
export const LOGO_MARK = "pi";

/** pi-hub mark: an app-icon badge with the pi glyph (π). */
export function logo(size = 22, mark = LOGO_MARK) {
  const span = document.createElement("span");
  span.className = "icon";
  span.style.width = `${size}px`;
  span.style.height = `${size}px`;
  const m = MARKS[mark] || MARKS[LOGO_MARK];
  span.innerHTML = `<svg viewBox="0 0 24 24">${m.body}${m.ink}</svg>`;
  return span;
}
