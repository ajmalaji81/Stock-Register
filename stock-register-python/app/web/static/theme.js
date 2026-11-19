// Light / dark mode and accent colour, remembered per browser (localStorage). The <head> script applies it before first paint.
(function () {
  var root = document.documentElement;
  var get = function (k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } };
  var set = function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} };
  var mq = window.matchMedia ? matchMedia("(prefers-color-scheme: dark)") : null;

  function apply() {
    var m = get("gb-mode", "light");
    var dark = m === "dark" || (m === "system" && mq && mq.matches);
    root.dataset.theme = dark ? "dark" : "light";
    root.dataset.accent = get("gb-accent", "blue");
    document.querySelectorAll("#mode-seg button").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.mode === m)); });
    document.querySelectorAll("#accent-swatches button").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.accent === root.dataset.accent)); });
  }

  document.querySelectorAll("#mode-seg button").forEach(function (b) {
    b.addEventListener("click", function () { set("gb-mode", b.dataset.mode); apply(); });
  });
  document.querySelectorAll("#accent-swatches button").forEach(function (b) {
    b.addEventListener("click", function () { set("gb-accent", b.dataset.accent); apply(); });
  });
  var t = document.getElementById("theme-toggle");
  if (t) t.addEventListener("click", function () { set("gb-mode", root.dataset.theme === "dark" ? "light" : "dark"); apply(); });
  if (mq && mq.addEventListener) mq.addEventListener("change", apply);
  window.addEventListener("storage", apply);  // another tab / frame changed the theme
  apply();
})();

// Hover tooltip for charts: any element with data-tip shows its text next to the cursor.
(function () {
  var tip = document.createElement("div");
  tip.className = "chart-tip"; tip.hidden = true; tip.setAttribute("role", "tooltip");
  document.body.appendChild(tip);
  function move(e) {
    var x = e.clientX + 14, y = e.clientY + 14, w = tip.offsetWidth, h = tip.offsetHeight;
    if (x + w > window.innerWidth - 8) x = e.clientX - w - 14;
    if (y + h > window.innerHeight - 8) y = e.clientY - h - 14;
    tip.style.left = x + "px"; tip.style.top = y + "px";
  }
  document.addEventListener("mouseover", function (e) {
    var el = e.target.closest ? e.target.closest("[data-tip]") : null;
    if (!el) { tip.hidden = true; return; }
    tip.textContent = el.getAttribute("data-tip"); tip.hidden = false; move(e);
  });
  document.addEventListener("mousemove", function (e) { if (!tip.hidden) move(e); });
  document.addEventListener("mouseleave", function () { tip.hidden = true; });
})();
