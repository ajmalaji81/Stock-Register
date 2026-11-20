// Keyboard shortcuts: press a key combination anywhere to add a sale, open a report, and so on.
// Every shortcut can be changed or reset in the panel (sidebar button "Shortcuts" or F1). Changes are saved in this browser only.
(function (root) {
  "use strict";

  // ---------------- pure logic (also run by the node tests) ----------------
  var MOD_ORDER = ["Ctrl", "Alt", "Shift", "Meta"];
  // Combinations the browser or the app itself already uses: refused when someone tries to assign them.
  var RESERVED = [
    "Ctrl+T", "Ctrl+N", "Ctrl+W", "Ctrl+R", "Ctrl+P", "Ctrl+S", "Ctrl+F", "Ctrl+L", "Ctrl+D", "Ctrl+H", "Ctrl+J", "Ctrl+U", "Ctrl+O",
    "Ctrl+A", "Ctrl+C", "Ctrl+V", "Ctrl+X", "Ctrl+Z", "Ctrl+Y", "Ctrl+Shift+T", "Ctrl+Shift+N", "Ctrl+Shift+W", "Ctrl+Shift+I",
    "Ctrl+Shift+J", "Ctrl+Shift+R", "Meta+T", "Meta+N", "Meta+W", "Meta+R", "Meta+P", "Meta+S", "Meta+F", "Meta+L", "Meta+Q", "Meta+H",
    "Meta+M", "Meta+C", "Meta+V", "Meta+X", "Meta+Z", "Meta+A", "Alt+D", "Alt+F", "Alt+E", "Alt+F4", "Alt+Left", "Alt+Right", "Alt+Home",
    "F5", "F11", "F12", "Alt+1", "Alt+2", "Alt+3", "Alt+4", "Alt+5", "Alt+6", "Alt+7", "Alt+8",
  ];

  function keyName(code, key) {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (/^F([1-9]|1[0-2])$/.test(code)) return code;
    var map = { Slash: "/", Backslash: "\\", Comma: ",", Period: ".", Semicolon: ";", Quote: "'", Minus: "-", Equal: "=", Backquote: "`",
      BracketLeft: "[", BracketRight: "]", ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down", Home: "Home", End: "End",
      PageUp: "PageUp", PageDown: "PageDown", Insert: "Insert", Delete: "Delete", Enter: "Enter", Space: "Space" };
    if (map[code]) return map[code];
    return key && key.length === 1 ? key.toUpperCase() : "";
  }

  // KeyboardEvent -> "Alt+S" ("" for a lone modifier key press)
  function comboFromEvent(e) {
    var k = keyName(e.code || "", e.key || "");
    if (!k) return "";
    var mods = [];
    if (e.ctrlKey) mods.push("Ctrl");
    if (e.altKey) mods.push("Alt");
    if (e.shiftKey) mods.push("Shift");
    if (e.metaKey) mods.push("Meta");
    return mods.concat([k]).join("+");
  }

  function parts(combo) { var p = combo.split("+"); return { key: p[p.length - 1], mods: p.slice(0, -1) }; }

  // A shortcut must be a function key, or carry Ctrl / Alt / Meta (so it can't fire while typing normal text).
  function isUsable(combo) {
    if (!combo) return false;
    var p = parts(combo);
    if (/^F([1-9]|1[0-2])$/.test(p.key)) return true;
    return p.mods.indexOf("Ctrl") >= 0 || p.mods.indexOf("Alt") >= 0 || p.mods.indexOf("Meta") >= 0;
  }

  // The key each action uses now: its saved choice, else its default. "" = switched off.
  function effective(actions, overrides) {
    var out = {};
    actions.forEach(function (a) { out[a.id] = Object.prototype.hasOwnProperty.call(overrides, a.id) ? overrides[a.id] : a.key; });
    return out;
  }

  // Why `combo` can't be given to action `id` ("" when it can).
  function problem(combo, id, actions, overrides) {
    if (combo === "") return "";
    if (!isUsable(combo)) return "Use Alt, Ctrl or Cmd with a key (or a function key like F2).";
    if (RESERVED.indexOf(combo) >= 0) return combo + " is used by your browser. Pick another.";
    var eff = effective(actions, overrides);
    for (var i = 0; i < actions.length; i++) {
      if (actions[i].id !== id && eff[actions[i].id] === combo) return combo + " is already used by \"" + actions[i].label + "\". Change or reset that one first.";
    }
    return "";
  }

  function find(actions, id) { return actions.filter(function (a) { return a.id === id; })[0]; }

  // Returns { overrides, error }. Storing the default removes the override, so "Reset" and "set it back by hand" are the same.
  function assign(overrides, actions, id, combo) {
    var err = problem(combo, id, actions, overrides);
    if (err) return { overrides: overrides, error: err };
    var next = JSON.parse(JSON.stringify(overrides));
    var a = find(actions, id);
    if (a && combo === a.key) delete next[id]; else next[id] = combo;
    return { overrides: next, error: "" };
  }

  function reset(overrides, actions, id) {
    var a = find(actions, id);
    return a ? assign(overrides, actions, id, a.key) : { overrides: overrides, error: "" };
  }

  function resetAll() { return {}; }

  // Which action does this key press trigger?
  function match(actions, overrides, combo) {
    if (!combo) return null;
    var eff = effective(actions, overrides);
    for (var i = 0; i < actions.length; i++) if (eff[actions[i].id] === combo) return actions[i];
    return null;
  }

  var core = { comboFromEvent: comboFromEvent, isUsable: isUsable, effective: effective, problem: problem, assign: assign, reset: reset,
    resetAll: resetAll, match: match, RESERVED: RESERVED };
  if (typeof module !== "undefined" && module.exports) { module.exports = core; return; }
  root.GBShortcuts = core;

  // ---------------- browser part ----------------
  var KEY = "gb-shortcuts";
  var dataEl = document.getElementById("gb-shortcuts-data");
  if (!dataEl) return;
  var actions = [];
  try { actions = JSON.parse(dataEl.textContent) || []; } catch (e) { actions = []; }

  var readOverrides = function () { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } };
  var writeOverrides = function (o) { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) {} };

  var inFrame = window.top !== window.self;
  var capturing = null;  // the action id being re-bound in the panel

  function go(a) {
    if (a.id === "search") { var s = document.querySelector(".tsearch input"); if (s) { s.focus(); s.select(); } else if (inFrame && window.top.document.querySelector(".tsearch input")) { window.top.document.querySelector(".tsearch input").focus(); } return; }
    if (a.id === "help") { if (inFrame && window.top.GBShortcutsOpen) window.top.GBShortcutsOpen(); else openPanel(); return; }
    if (!a.url) return;
    if (a.id === "workspace") {  // the workspace itself: nothing to do inside it, break out when inside a tab
      if (inFrame) window.top.location.href = a.url;
      else if (!window.gbWorkspaceOpen) window.location.href = a.url;
      return;
    }
    if (window.gbWorkspaceOpen) window.gbWorkspaceOpen(a.url);  // top page of the workspace: open in the current tab
    else window.location.href = a.url;  // a normal page, or the page shown inside a tab
  }

  document.addEventListener("keydown", function (e) {
    if (capturing || e.repeat || e.isComposing) return;
    var combo = comboFromEvent(e);
    if (!isUsable(combo)) return;
    var a = match(actions, readOverrides(), combo);
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    go(a);
  }, true);

  // ---- the panel ----
  var modal = document.getElementById("sc-modal"), list = document.getElementById("sc-list"), msg = document.getElementById("sc-msg");

  function say(text, bad) { msg.textContent = text; msg.className = "sc-msg " + (bad ? "bad" : "ok"); }

  function chip(key) { var k = document.createElement("kbd"); k.textContent = key || "off"; if (!key) k.className = "none"; return k; }

  function render() {
    var o = readOverrides(), eff = effective(actions, o), groups = {}, order = [];
    actions.forEach(function (a) { if (!groups[a.group]) { groups[a.group] = []; order.push(a.group); } groups[a.group].push(a); });
    list.textContent = "";
    order.forEach(function (g) {
      var h = document.createElement("h3"); h.textContent = g; list.appendChild(h);
      groups[g].forEach(function (a) {
        var row = document.createElement("div"); row.className = "sc-row" + (capturing === a.id ? " cap" : "");
        var lab = document.createElement("span"); lab.className = "lab"; lab.textContent = a.label;
        var k = chip(capturing === a.id ? "Press keys…" : eff[a.id]);
        var edit = document.createElement("button"); edit.type = "button"; edit.className = "btn ghost sm"; edit.textContent = capturing === a.id ? "Cancel" : "Edit";
        edit.addEventListener("click", function () { capturing = capturing === a.id ? null : a.id; say(capturing ? "Press the new keys for \"" + a.label + "\". Esc cancels, Backspace turns it off." : "", false); render(); });
        var rs = document.createElement("button"); rs.type = "button"; rs.className = "btn ghost sm"; rs.textContent = "Reset";
        rs.disabled = !Object.prototype.hasOwnProperty.call(o, a.id);
        rs.title = "Back to " + a.key;
        rs.addEventListener("click", function () {
          var r = reset(readOverrides(), actions, a.id);
          if (r.error) { say(r.error, true); return; }
          writeOverrides(r.overrides); capturing = null; say("\"" + a.label + "\" is back to " + a.key + ".", false); render(); badges();
        });
        row.appendChild(lab); row.appendChild(k); row.appendChild(edit); row.appendChild(rs); list.appendChild(row);
      });
    });
  }

  // while a row is waiting for keys, the next combination is the answer
  document.addEventListener("keydown", function (e) {
    if (!capturing || !modal || modal.hidden) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); capturing = null; say("", false); render(); return; }
    var combo = e.key === "Backspace" || e.key === "Delete" ? "" : comboFromEvent(e);
    if (combo === "" && e.key !== "Backspace" && e.key !== "Delete") return;  // a lone Alt / Ctrl press: keep waiting
    e.preventDefault(); e.stopPropagation();
    var id = capturing, a = find(actions, id);
    var r = assign(readOverrides(), actions, id, combo);
    if (r.error) { say(r.error, true); return; }
    writeOverrides(r.overrides); capturing = null;
    say(combo ? "\"" + a.label + "\" is now " + combo + "." : "\"" + a.label + "\" is switched off.", false);
    render(); badges();
  }, true);

  function openPanel() { if (!modal) return; capturing = null; say("", false); render(); modal.hidden = false; var b = document.getElementById("sc-close"); if (b) b.focus(); }
  function closePanel() { if (modal) { modal.hidden = true; capturing = null; } }
  window.GBShortcutsOpen = openPanel;

  if (modal) {
    document.getElementById("sc-close").addEventListener("click", closePanel);
    document.getElementById("sc-reset-all").addEventListener("click", function () {
      writeOverrides(resetAll()); capturing = null; say("All shortcuts are back to their defaults.", false); render(); badges();
    });
    modal.addEventListener("mousedown", function (e) { if (e.target === modal) closePanel(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !modal.hidden && !capturing) closePanel(); });
  }
  var openBtn = document.getElementById("sc-open");
  if (openBtn) openBtn.addEventListener("click", openPanel);

  // ---- little key badges beside the sidebar items that have a shortcut ----
  function badges() {
    var eff = effective(actions, readOverrides());
    document.querySelectorAll(".side a[data-nav]").forEach(function (link) {
      var old = link.querySelector(".sk"); if (old) old.remove();
      var a = actions.filter(function (x) { return x.nav === link.dataset.nav; })[0];
      if (a && eff[a.id]) { var s = document.createElement("kbd"); s.className = "sk"; s.textContent = eff[a.id]; link.appendChild(s); }
    });
    if (openBtn) openBtn.title = "Keyboard shortcuts (" + (eff.help || "off") + ")";
  }
  badges();
  window.addEventListener("storage", function (e) { if (e.key === KEY) { badges(); if (modal && !modal.hidden) render(); } });
})(typeof window !== "undefined" ? window : this);
