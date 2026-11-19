// Searchable dropdowns: turns <select name="itemId"> (and any select[data-search]) into click-to-open, type-to-filter pickers.
// The original <select> stays in the form (hidden), so submits and change handlers keep working.
(function () {
  var open = null;

  function enhance(sel) {
    if (sel.dataset.combo) return;
    sel.dataset.combo = "1";
    var opts = function () { return Array.prototype.slice.call(sel.options); };
    var wrap = document.createElement("div");
    wrap.className = "combo";
    var input = document.createElement("input");
    input.type = "text"; input.autocomplete = "off"; input.className = "combo-in";
    input.setAttribute("role", "combobox"); input.setAttribute("aria-expanded", "false");
    var blank = opts().filter(function (o) { return o.value === ""; })[0];
    input.placeholder = blank && blank.text ? blank.text + " — click or type to search" : "Click or type to search";
    input.required = sel.required;
    sel.required = false;
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(input);
    wrap.appendChild(sel);
    sel.style.display = "none";
    var list = document.createElement("div");
    list.className = "combo-list"; list.hidden = true; list.setAttribute("role", "listbox");
    document.body.appendChild(list);
    var hi = -1, shown = [];

    function label() { var o = sel.options[sel.selectedIndex]; return o && o.value !== "" ? o.text : ""; }
    function sync() { input.value = label(); }
    function place() {
      var r = input.getBoundingClientRect();
      list.style.left = r.left + "px"; list.style.minWidth = Math.max(r.width, 220) + "px";
      var below = window.innerHeight - r.bottom, up = r.top > below && below < 200;
      list.style.maxHeight = Math.max(120, Math.min(280, (up ? r.top : below) - 12)) + "px";
      list.style.top = up ? "auto" : r.bottom + 2 + "px"; list.style.bottom = up ? window.innerHeight - r.top + 2 + "px" : "auto";
    }
    function render(q) {
      var words = q.toLowerCase().split(/\s+/).filter(Boolean);
      shown = opts().filter(function (o) {
        var t = o.text.toLowerCase();
        return words.every(function (w) { return t.indexOf(w) >= 0; });
      });
      list.innerHTML = "";
      shown.forEach(function (o, i) {
        var d = document.createElement("div");
        d.className = "combo-opt" + (o.value === sel.value ? " sel" : ""); d.setAttribute("role", "option");
        d.textContent = o.text;
        d.addEventListener("mousedown", function (e) { e.preventDefault(); pick(o); });
        list.appendChild(d);
      });
      if (!shown.length) { var n = document.createElement("div"); n.className = "combo-opt muted"; n.textContent = "No match"; list.appendChild(n); }
      hi = shown.length ? 0 : -1; mark();
    }
    function mark() {
      Array.prototype.forEach.call(list.querySelectorAll(".combo-opt"), function (d, i) { d.classList.toggle("hi", i === hi); });
      var el = list.querySelectorAll(".combo-opt")[hi]; if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
    }
    function show() { if (open && open !== close) open(); render(input.value === label() ? "" : input.value); place(); list.hidden = false; input.setAttribute("aria-expanded", "true"); open = close; }
    function close() { list.hidden = true; input.setAttribute("aria-expanded", "false"); sync(); if (open === close) open = null; }
    function pick(o) {
      sel.value = o.value; sync(); list.hidden = true; input.setAttribute("aria-expanded", "false");
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
    input.addEventListener("focus", function () { input.select(); show(); });
    input.addEventListener("click", function () { if (list.hidden) show(); });
    input.addEventListener("input", function () { render(input.value); place(); list.hidden = false; });
    input.addEventListener("blur", function () { setTimeout(close, 120); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault(); if (list.hidden) show();
        hi = Math.max(0, Math.min(shown.length - 1, hi + (e.key === "ArrowDown" ? 1 : -1))); mark();
      } else if (e.key === "Enter" && !list.hidden) {
        e.preventDefault(); if (shown[hi]) pick(shown[hi]);
      } else if (e.key === "Escape") { close(); }
    });
    window.addEventListener("scroll", function () { if (!list.hidden) place(); }, true);
    window.addEventListener("resize", function () { if (!list.hidden) place(); });
    sel.addEventListener("change", sync);  // value set from code (e.g. edit form)
    sync();
  }

  window.enhanceSelect = enhance;
  function auto() { document.querySelectorAll("select[name=itemId], select[data-search]").forEach(enhance); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", auto); else auto();
})();
