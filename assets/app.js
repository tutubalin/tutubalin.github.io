/* Renders the tiles on index.html from the PROJECTS list in projects.js.
   You should not need to touch this file — edit projects.js instead. */

(function () {
  "use strict";

  var grid = document.getElementById("grid");
  var site = window.SITE || {};
  var projects = window.PROJECTS || [];

  /* header / footer text from projects.js */
  document.title = site.title || document.title;
  if (site.title) document.getElementById("site-title").textContent = site.title;
  if (site.tagline !== undefined) document.getElementById("site-tagline").textContent = site.tagline;
  if (site.footer !== undefined) document.getElementById("site-footer").textContent = site.footer;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* emoji icons render as text; anything with a "/" is treated as an image */
  function isImagePath(icon) {
    return typeof icon === "string" && icon.indexOf("/") !== -1;
  }

  /* derive translucent chip background / border from a #rrggbb color */
  function accents(color) {
    if (/^#[0-9a-fA-F]{6}$/.test(color)) {
      return {
        chip: color + "1f",   /* ~12% alpha */
        ring: color + "3d",   /* ~24% alpha */
        border: color + "59"  /* ~35% alpha, used on hover */
      };
    }
    return null;
  }

  var PALETTE = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#a855f7"];

  function autoColor(name, index) {
    var h = 0;
    var s = String(name || "") + index;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }

  function tileHTML(p, i) {
    var url = p.url || "#";
    var external = /^https?:\/\//i.test(url);
    var color = p.color || autoColor(p.name, i);
    var a = accents(color);
    var icon = isImagePath(p.icon)
      ? '<img src="' + esc(p.icon) + '" alt="" loading="lazy">'
      : esc(p.icon || "📄");

    return (
      '<a class="tile' + (external ? " tile-external" : "") + '"' +
      ' href="' + esc(url) + '"' +
      (external ? ' target="_blank" rel="noopener noreferrer"' : "") +
      ' style="--i:' + i + ";" +
      " --accent:" + esc(color) + ";" +
      (a ? " --accent-chip:" + a.chip + "; --accent-ring:" + a.ring +
          "; --accent-border:" + a.border + ";" : "") +
      '">' +
      '<span class="tile-icon">' + icon + "</span>" +
      '<span class="tile-name">' + esc(p.name || "Untitled") + "</span>" +
      (p.description ? '<span class="tile-desc">' + esc(p.description) + "</span>" : "") +
      "</a>"
    );
  }

  if (!projects.length) {
    grid.innerHTML =
      '<div class="empty-state">No projects yet.<br>' +
      "Open <code>projects.js</code> and add your first one — it takes about a minute.</div>";
    return;
  }

  grid.innerHTML = projects.map(tileHTML).join("");
})();
