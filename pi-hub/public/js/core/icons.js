/**
 * icons — a small inline SVG set (stroke-based, 24-unit viewBox) drawn for
 * pi-hub. Static trusted markup only: `innerHTML` here never touches server
 * or model data.
 */
const P = {
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  "chevron-down": '<path d="m6 9 6 6 6-6"/>',
  "chevron-left": '<path d="m15 18-6-6 6-6"/>',
  "chevron-right": '<path d="m9 18 6-6-6-6"/>',
  "arrow-up": '<path d="M12 19V5M5 12l7-7 7 7"/>',
  back: '<path d="M19 12H5m7 7-7-7 7-7"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/>',
  square: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  gear: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  palette:
    '<circle cx="13.5" cy="6.5" r=".8"/><circle cx="17.5" cy="10.5" r=".8"/><circle cx="8.5" cy="7.5" r=".8"/><circle cx="6.5" cy="12.5" r=".8"/><path d="M12 2a10 10 0 1 0 0 20c1.2 0 2-.9 2-2 0-.5-.2-1-.5-1.4-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h2.3c2.3 0 4.2-1.9 4.2-4.2C21.5 6.2 17.3 2 12 2Z"/>',
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
  alert: '<path d="M12 3 2 20h20Z"/><path d="M12 10v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  eye: '<path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="2.8"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/>',
  "file-code": '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="m10 13-2 2 2 2M14 13l2 2-2 2"/>',
  "message": '<path d="M21 12a8.5 8.5 0 0 1-8.5 8.5H4L3 22l1.5-4.5A8.5 8.5 0 1 1 21 12Z"/>',
  "dots": '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
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

/** pi-hub mark: the hand-drawn π from pi.svg (path data inlined,
 *  accent fill), recoloured with every theme switch. */
const LOGO_INK = '<g transform="translate(-0.281 -4.295) scale(0.031358)">' +
      '<path style="fill:var(--accent)" d="m669.08 247.6c-124.67 0.7349-249.35-0.1383-374.02 0.3307-33.876 0.2722-40.957 1.2158-46.264 2.0755-32.004 5.1843-45.23 11.38-65.094 30.594-22.937 22.186-38.61 46.048-52.5 79.875-4.477 10.903-12.027 32.811-15.5 44.938l-1.5 5.25 17.375-0.031 6.3438-10.281c15.054-24.471 33.057-45.134 47.469-54.5 17.984-11.688 41.997-17.162 75.562-17.188h11.344c-2.5989 29.804-4.5922 59.661-6.75 89.5-6.7028 93.243-6.803 94.425-10.562 118.5-10.954 70.149-20.595 96.734-49.812 137.38-26.329 36.623-30.848 45.184-33.031 62.594-3.0318 24.18 9.6834 44.375 33.031 52.5 10.888 3.5794 23.552 3.6494 34.031-1.2187v0.031c12.054-5.9343 26.101-22.343 34.844-40.688 15.985-33.541 33.797-126.34 46-239.59 1.0341-9.5973 13.031-174.36 13.031-178.79l140.25-0.2062c-9.2089 64.187-14.802 128.9-20.312 193.5-1.7146 22.465-2.3431 96.724-1 117.16 3.7518 57.075 12.989 92.631 29.906 115 14.68 19.411 32.214 31.323 52.812 35.906 9.2392 2.0555 28.464 1.5225 37.844-1.0625 15.806-4.3559 32.792-14.858 47.062-29.094 18.537-18.492 30.485-41.756 39.469-76.906 3.464-13.553 8.9688-42.819 8.9688-47.594l-17.406 0.3437c-2.9839 14.493-4.1572 19.007-6.4688 24.688-6.6041 16.228-19.404 28.301-36.125 34.156-20.731 6.1896-42.772 3.0609-61.188-7.8124-17.898-11.691-28.855-31.322-33.406-59.875-4.7688-99.638 6.7697-199.58 20.594-298.16l135-0.25v-81.062z"/></g>';

/** pi-hub mark: an app-icon badge with the pi glyph (π). */
export function logo(size = 22) {
  const span = document.createElement("span");
  span.className = "icon";
  span.style.width = `${size}px`;
  span.style.height = `${size}px`;
  span.innerHTML = `<svg viewBox="0 0 24 24">${LOGO_INK}</svg>`;
  return span;
}
