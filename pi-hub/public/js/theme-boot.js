/* Runs synchronously from <head>, before the module graph and first paint.
 *
 * Two jobs, both about not showing the wrong thing for one frame:
 *  - apply the saved theme, so a dark-theme reload never paints the default
 *    light shell first (`app.js` re-applies it later; it is already correct);
 *  - point `color-scheme` at that theme, so the browser's own canvas/scrollbar
 *    colours match instead of flashing the OS scheme.
 *
 * The dark list mirrors `tokens.css`; `E12b6` asserts they agree.
 */
(function () {
  var DARK = ["night", "dawn", "midnight", "slate", "forest", "plum"];
  function isDark(theme) {
    if (theme) return DARK.indexOf(theme) !== -1;
    try {
      return !window.matchMedia("(prefers-color-scheme: light)").matches;
    } catch (e) {
      return false;
    }
  }
  var theme = null;
  try {
    var raw = localStorage.getItem("pi-hub-prefs");
    theme = raw ? JSON.parse(raw).theme || null : null;
  } catch (e) {}
  var html = document.documentElement;
  if (theme) html.dataset.theme = theme;
  var meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.setAttribute("content", isDark(theme) ? "dark" : "light");
  window.__piHubIsDark = isDark;
})();
