// Run by tests/test_shortcuts.py: node tests/js/shortcuts.test.js
const assert = require("assert");
const S = require("../../app/web/static/shortcuts.js");

const actions = [
  { id: "sales.new", label: "Add sales invoice", key: "Alt+S" },
  { id: "purchase.new", label: "Add purchase bill", key: "Alt+P" },
  { id: "stock.report", label: "Stock report", key: "Alt+K" },
  { id: "help", label: "Help", key: "F1" },
];
const ev = (o) => Object.assign({ ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, code: "", key: "" }, o);

// key presses -> combo strings (by physical key, so Alt+S works on a Mac where Option+S types a symbol)
assert.strictEqual(S.comboFromEvent(ev({ altKey: true, code: "KeyS", key: "ß" })), "Alt+S");
assert.strictEqual(S.comboFromEvent(ev({ ctrlKey: true, shiftKey: true, code: "KeyK", key: "K" })), "Ctrl+Shift+K");
assert.strictEqual(S.comboFromEvent(ev({ altKey: true, code: "Slash", key: "/" })), "Alt+/");
assert.strictEqual(S.comboFromEvent(ev({ code: "F6", key: "F6" })), "F6");
assert.strictEqual(S.comboFromEvent(ev({ altKey: true, code: "AltLeft", key: "Alt" })), "", "a lone modifier is not a shortcut");

// what may be used
assert.ok(S.isUsable("Alt+S") && S.isUsable("Ctrl+Shift+K") && S.isUsable("F2") && S.isUsable("Shift+F2"));
assert.ok(!S.isUsable("S") && !S.isUsable("Shift+S") && !S.isUsable(""), "plain typing keys are refused");

// defaults, matching
assert.strictEqual(S.match(actions, {}, "Alt+S").id, "sales.new");
assert.strictEqual(S.match(actions, {}, "Alt+Z"), null);

// editing: a new key works, the old one stops working
let r = S.assign({}, actions, "sales.new", "Alt+N");
assert.strictEqual(r.error, "");
assert.deepStrictEqual(r.overrides, { "sales.new": "Alt+N" });
assert.strictEqual(S.match(actions, r.overrides, "Alt+N").id, "sales.new");
assert.strictEqual(S.match(actions, r.overrides, "Alt+S"), null);

// refused: browser keys, another action's key (including a customised one), unusable keys; nothing changes then
assert.ok(S.assign({}, actions, "sales.new", "Ctrl+T").error.includes("browser"));
assert.ok(S.assign({}, actions, "sales.new", "Alt+D").error.includes("browser"));
assert.ok(S.assign({}, actions, "sales.new", "Alt+3").error.includes("browser"), "Alt+1..8 switch workspace tabs");
assert.ok(S.assign({}, actions, "sales.new", "Alt+P").error.includes("Add purchase bill"));
assert.ok(S.assign(r.overrides, actions, "purchase.new", "Alt+N").error.includes("Add sales invoice"));
assert.ok(S.assign({}, actions, "sales.new", "N").error.includes("Alt, Ctrl"));
assert.deepStrictEqual(S.assign({}, actions, "sales.new", "Ctrl+T").overrides, {});

// a freed default can be taken by another action
r = S.assign({}, actions, "sales.new", "Alt+N");
r = S.assign(r.overrides, actions, "purchase.new", "Alt+S");
assert.strictEqual(r.error, "");
assert.strictEqual(S.match(actions, r.overrides, "Alt+S").id, "purchase.new");

// switching off with "" and bringing it back
r = S.assign({}, actions, "help", "");
assert.deepStrictEqual(r.overrides, { help: "" });
assert.strictEqual(S.match(actions, r.overrides, "F1"), null);

// reset: setting the default again removes the override; reset blocked while someone else holds the default
r = S.assign({}, actions, "sales.new", "Alt+N");
assert.deepStrictEqual(S.reset(r.overrides, actions, "sales.new").overrides, {});
const swapped = S.assign(S.assign({}, actions, "sales.new", "Alt+N").overrides, actions, "purchase.new", "Alt+S").overrides;
assert.ok(S.reset(swapped, actions, "sales.new").error.includes("Add purchase bill"), "default Alt+S is taken by purchase now");
assert.deepStrictEqual(S.resetAll(swapped), {});
assert.strictEqual(S.match(actions, S.resetAll(), "Alt+S").id, "sales.new");

console.log("shortcuts: all checks passed");
