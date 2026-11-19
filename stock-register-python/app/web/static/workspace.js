// In-app tabs: every tab is an iframe that stays loaded while hidden, so unsaved forms survive switching tabs.
(function () {
  var MAX = 8, KEY = "gb-ws-tabs";
  var tabsEl = document.getElementById("ws-tabs"), framesEl = document.getElementById("ws-frames");
  if (!tabsEl) return;
  var tabs = [], active = null, seq = 0;

  function titleOf(fr) {
    try { return (fr.contentDocument.title || "").replace(/\s+[—-]\s+GodownBook$/, "") || "Loading…"; } catch (e) { return "Page"; }
  }
  function urlOf(t) {
    try {
      var l = t.frame.contentWindow.location;
      if (l.protocol === "about:" || l.pathname.indexOf("/app") !== 0) return t.url;  // not loaded yet
      return l.pathname + l.search;
    } catch (e) { return t.url; }
  }
  function save() {
    try { sessionStorage.setItem(KEY, JSON.stringify({ urls: tabs.map(urlOf), active: tabs.indexOf(active) })); } catch (e) {}
  }
  function dirty(t) { return /^\/app\/billing\/(new|[^/]+\/edit)/.test(urlOf(t)); }

  function paint() {
    tabs.forEach(function (t) {
      var on = t === active;
      t.btn.classList.toggle("on", on); t.btn.setAttribute("aria-selected", String(on));
      t.frame.classList.toggle("on", on);
    });
    var p = active ? urlOf(active).split("?")[0] : "", best = null;
    document.querySelectorAll(".side a[href]").forEach(function (a) {
      a.classList.remove("on");
      var h = a.getAttribute("href").split("?")[0];
      if (h && h !== "/app" && (p === h || p.indexOf(h + "/") === 0) && (!best || h.length > best.h.length)) best = { a: a, h: h };
      if (h === "/app" && p === "/app" && !best) best = { a: a, h: h };
    });
    if (best) best.a.classList.add("on");
  }
  function show(t) { active = t; paint(); save(); }

  function close(t) {
    if (dirty(t) && !confirm("Close this tab? A bill that isn't saved will be lost.")) return;
    var i = tabs.indexOf(t);
    tabs.splice(i, 1); t.btn.parentNode.remove(); t.frame.remove();
    if (!tabs.length) { open("/app"); return; }
    if (active === t) show(tabs[Math.min(i, tabs.length - 1)]); else save();
  }

  function open(url) {
    if (tabs.length >= MAX) { alert("You can keep up to " + MAX + " tabs open. Close one first."); return null; }
    var t = { id: ++seq, url: url };
    var wrap = document.createElement("div"); wrap.className = "ws-tab";
    var b = document.createElement("button"); b.type = "button"; b.className = "ws-tab-btn"; b.setAttribute("role", "tab"); b.textContent = "Loading…";
    var x = document.createElement("button"); x.type = "button"; x.className = "ws-x"; x.textContent = "×"; x.setAttribute("aria-label", "Close tab");
    wrap.appendChild(b); wrap.appendChild(x); tabsEl.appendChild(wrap);
    var fr = document.createElement("iframe"); fr.className = "ws-frame"; fr.title = "Tab " + t.id;
    fr.addEventListener("load", function () { b.textContent = titleOf(fr); b.title = b.textContent; paint(); save(); });
    fr.src = url; framesEl.appendChild(fr);
    t.btn = b; t.frame = fr;
    b.addEventListener("click", function () { show(t); });
    x.addEventListener("click", function () { close(t); });
    tabs.push(t); show(t);
    return t;
  }

  // sidebar + search: open in the current tab, or a new one with Ctrl / Shift / middle click
  var side = document.querySelector(".side");
  side.addEventListener("click", function (e) {
    var a = e.target.closest("a[href]"); if (!a) return;
    var h = a.getAttribute("href");
    if (!h || h.indexOf("/app") !== 0 || h === "/app/workspace") return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey || e.shiftKey) open(h); else { active.frame.src = h; show(active); }
  });
  side.addEventListener("auxclick", function (e) {
    var a = e.target.closest("a[href]");
    if (e.button === 1 && a && a.getAttribute("href").indexOf("/app") === 0) { e.preventDefault(); open(a.getAttribute("href")); }
  });
  var search = document.querySelector(".tsearch");
  if (search) search.addEventListener("submit", function (e) {
    e.preventDefault();
    var q = search.querySelector("input").value;
    active.frame.src = search.getAttribute("action") + "?q=" + encodeURIComponent(q); show(active);
  });
  document.getElementById("ws-add").addEventListener("click", function () { open("/app"); });
  document.addEventListener("keydown", function (e) {
    if (e.altKey && /^[1-8]$/.test(e.key) && tabs[+e.key - 1]) { e.preventDefault(); show(tabs[+e.key - 1]); }
  });

  var saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(KEY)); } catch (e) {}
  if (saved && saved.urls && saved.urls.length) {
    saved.urls.slice(0, MAX).forEach(function (u) { if (typeof u === "string" && u.indexOf("/app") === 0) open(u); });
    if (tabs[saved.active]) show(tabs[saved.active]);
  }
  if (!tabs.length) open("/app");
})();
