// Bill editor: live totals, discount ₹ <-> %, party search (name or phone), split payments.
// Mirrors app/core/gst.py; the server recomputes and validates everything.
(function () {
  var EPS = 2.220446049250313e-16;
  var r2 = function (n) { return Math.round((n + EPS) * 100) / 100; };
  var form = document.getElementById("bill");
  if (!form) return;
  var table = document.getElementById("lines");
  var tpl = document.getElementById("line-tpl");
  var norm = function (s) { return (s || "").trim().toLowerCase(); };
  var digits = function (s) { return (s || "").replace(/\D/g, ""); };
  var inr = function (n) { return "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var num = function (el) { var v = parseFloat(el.value); return isFinite(v) ? v : 0; };
  var json = function (id, d) { try { return JSON.parse(document.getElementById(id).textContent); } catch (e) { return d; } };
  var total = 0;

  // A save the server rejects redirects back to a fresh form. Keep what was typed in this tab and put it back
  // (once, only when that redirect brought an error message).
  var DRAFT = "gb-bill-draft", here = location.pathname + location.search, draft = null;
  try {
    var raw = sessionStorage.getItem(DRAFT);
    sessionStorage.removeItem(DRAFT);
    var d0 = raw ? JSON.parse(raw) : null;
    if (d0 && d0.url === here && Date.now() - d0.ts < 10 * 60 * 1000 && document.querySelector(".flash.err")) draft = d0;
  } catch (e) { draft = null; }

  // ---------- party search ----------
  var parties = json("parties-data", []);
  var qBox = document.getElementById("party-q"), hidden = document.getElementById("party");
  var list = document.getElementById("party-list"), hint = document.getElementById("party-hint");
  var partyState = "";

  function pick(p) {
    hidden.value = p ? p.id : "";
    partyState = p ? p.state || "" : "";
    qBox.value = p ? p.name + (p.phone ? " · " + p.phone : "") : qBox.value;
    list.hidden = true;
    hint.textContent = p ? (p.state ? "State: " + p.state : "") : "";
    recalc();
  }
  function matches(q) {
    var t = norm(q), d = digits(q);
    if (!t) return [];
    return parties.filter(function (p) {
      return norm(p.name).indexOf(t) >= 0 || (d.length >= 3 && digits(p.phone).indexOf(d) >= 0);
    });
  }
  function showList() {
    var typed = qBox.value.trim() !== "";
    var m = (typed ? matches(qBox.value) : parties).slice(0, 60);
    list.innerHTML = "";
    m.forEach(function (p) {
      var b = document.createElement("button");
      b.type = "button"; b.className = "popt";
      b.textContent = p.name + (p.phone ? " · " + p.phone : "");
      b.addEventListener("mousedown", function (e) { e.preventDefault(); pick(p); });
      list.appendChild(b);
    });
    if (!m.length) { var n = document.createElement("div"); n.className = "popt muted"; n.textContent = "No match. Add the party under Parties first."; list.appendChild(n); }
    list.hidden = false;
  }
  if (qBox) {
    var initial = parties.filter(function (p) { return p.id === hidden.value; })[0];
    if (initial) pick(initial);
    qBox.addEventListener("input", function () {
      hidden.value = ""; partyState = ""; hint.textContent = "";
      var m = matches(qBox.value), d = digits(qBox.value);
      if (d.length >= 10 && m.length === 1) { pick(m[0]); return; }  // a full phone number picks the party
      showList(); recalc();
    });
    qBox.addEventListener("focus", function () { qBox.select(); showList(); });
    qBox.addEventListener("click", showList);
    qBox.addEventListener("blur", function () { setTimeout(function () { list.hidden = true; }, 120); });
    qBox.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !list.hidden) {
        e.preventDefault();
        var m = matches(qBox.value);
        if (m.length) pick(m[0]);
      }
    });
  }

  function interState() {
    var pos = document.getElementById("pos").value;
    var st = pos || partyState || form.dataset.businessState;
    var a = norm(form.dataset.businessState), b = norm(st);
    return document.getElementById("gst").checked && a !== "" && b !== "" && a !== b;
  }

  // ---------- lines ----------
  function recalc() {
    var gst = document.getElementById("gst").checked;
    var sub = 0, tax = 0, gross = 0;
    table.querySelectorAll("tr.line").forEach(function (tr) {
      var qty = num(tr.querySelector(".f-qty")), rate = num(tr.querySelector(".f-rate"));
      var g = qty * rate, pctEl = tr.querySelector(".f-disc"), amtEl = tr.querySelector(".f-discamt");
      if (tr.dataset.src === "amt") {  // typed a rupee discount: keep it, derive the percent
        var a = Math.min(Math.max(0, num(amtEl)), g);
        pctEl.value = g > 0 ? String(Number((a / g * 100).toFixed(6))) : "0";
      } else {  // typed a percent: derive the rupee discount
        var p0 = Math.min(100, Math.max(0, num(pctEl)));
        amtEl.value = String(r2(g * p0 / 100));
      }
      var disc = Math.min(100, Math.max(0, num(pctEl)));
      var tr_ = Math.max(0, num(tr.querySelector(".f-tax")));
      var taxable = r2(g * (1 - disc / 100));
      var t = gst ? r2((taxable * tr_) / 100) : 0;
      tr.querySelector(".f-amt").textContent = inr(r2(taxable + t));
      sub += taxable; tax += t; gross += g;
    });
    sub = r2(sub); tax = r2(tax);
    var exact = r2(sub + tax); total = Math.round(exact);
    document.getElementById("t-sub").textContent = inr(sub);
    document.getElementById("t-disc").textContent = inr(r2(gross - sub));
    document.getElementById("t-tax").textContent = inr(tax);
    document.getElementById("t-tax-label").textContent = interState() ? "IGST" : "CGST + SGST";
    document.getElementById("t-round").textContent = inr(r2(total - exact));
    document.getElementById("t-total").textContent = inr(total);
    paySummary();
  }

  function tokens(tr) { return (tr.querySelector(".f-serials").value || "").split(/[\s,;]+/).filter(Boolean); }
  function serialUI(tr) {
    var sel = tr.querySelector(".f-item"), o = sel.options[sel.selectedIndex];
    var tracked = o && o.getAttribute("data-serial") === "1";
    var box = tr.querySelector(".serial-box");
    box.hidden = !tracked;
    if (!tracked) { tr.querySelector(".f-serials").value = ""; return; }
    var n = tokens(tr).length, q = num(tr.querySelector(".f-qty"));
    var el = tr.querySelector(".f-scount");
    el.textContent = n + " of " + q + " IMEI" + (q === 1 ? "" : "s") + " entered";
    el.className = "f-scount " + (n === q ? "in" : "out");
  }

  function addLine(d) {
    var tr = tpl.content.firstElementChild.cloneNode(true);
    var sel = tr.querySelector(".f-item");
    sel.addEventListener("change", function (e) {
      var o = e.target.options[e.target.selectedIndex];
      tr.querySelector(".f-rate").value = o.getAttribute("data-price") || 0;
      tr.querySelector(".f-tax").value = o.getAttribute("data-gst") || 0;
      serialUI(tr);
      recalc();
    });
    tr.querySelector(".f-serials").addEventListener("input", function () { serialUI(tr); });
    tr.querySelector(".f-qty").addEventListener("input", function () { serialUI(tr); });
    tr.querySelector(".f-sfile").addEventListener("change", function (e) {
      var f = e.target.files[0]; if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        var ta = tr.querySelector(".f-serials");
        ta.value = (ta.value.trim() ? ta.value.trim() + "\n" : "") + String(r.result).split(/[\r\n,;]+/).map(function (x) { return x.trim(); }).filter(function (x) { return x && !/^(imei|serial)/i.test(x); }).join("\n");
        serialUI(tr);
      };
      r.readAsText(f); e.target.value = "";
    });
    tr.querySelector(".f-discamt").addEventListener("input", function () { tr.dataset.src = "amt"; });
    tr.querySelector(".f-disc").addEventListener("input", function () { tr.dataset.src = "pct"; });
    tr.querySelector(".f-del").addEventListener("click", function () {
      if (table.querySelectorAll("tr.line").length > 1) { tr.remove(); recalc(); }
    });
    if (d) {
      sel.value = d.itemId;
      tr.querySelector("[name=description]").value = d.description || "";
      tr.querySelector(".f-qty").value = d.qty;
      tr.querySelector(".f-rate").value = d.rate;
      tr.querySelector(".f-disc").value = d.discountPct;
      tr.querySelector(".f-tax").value = d.taxRate;
      tr.querySelector(".f-serials").value = d.serials || "";
      if (d.src) tr.dataset.src = d.src;
      if (d.discAmt != null) tr.querySelector(".f-discamt").value = d.discAmt;
    }
    table.appendChild(tr);
    if (window.enhanceSelect) window.enhanceSelect(sel);
    serialUI(tr);
  }

  // ---------- split payments ----------
  var pays = document.getElementById("pays"), payTpl = document.getElementById("pay-tpl");
  function paid() {
    var s = 0;
    if (pays) pays.querySelectorAll(".pay").forEach(function (r) { s += num(r.querySelector(".p-amt")); });
    return r2(s);
  }
  function paySummary() {
    var el = document.getElementById("pay-summary");
    if (!el) return;
    var p = paid(), bal = r2(total - p);
    el.textContent = "Paid " + inr(p) + " · " + (bal < 0 ? "Over by " + inr(-bal) : "Balance " + inr(bal));
    el.className = bal < 0 ? "out" : "muted";
  }
  function addPay(d) {
    var r = payTpl.content.firstElementChild.cloneNode(true);
    var mode = r.querySelector(".p-mode"), fin = r.querySelector(".p-fin");
    function sync() { fin.style.display = mode.value === "FINANCE" ? "" : "none"; if (mode.value !== "FINANCE") r.querySelector(".p-fin-in").value = ""; }
    mode.addEventListener("change", function () { sync(); paySummary(); });
    r.querySelector(".p-del").addEventListener("click", function () { r.remove(); paySummary(); });
    if (d) {
      mode.value = d.mode; r.querySelector(".p-amt").value = d.amount; r.querySelector(".p-fin-in").value = d.finance || "";
    } else if (pays.children.length) {
      r.querySelector(".p-amt").value = Math.max(0, r2(total - paid()));
    }
    sync();
    pays.appendChild(r);
    paySummary();
  }
  if (pays) {
    document.getElementById("add-pay").addEventListener("click", function () { addPay(); });
    (draft ? draft.pays : json("edit-pays", [])).forEach(addPay);
  }

  // ---------- submit guard ----------
  form.addEventListener("submit", function (e) {
    var msg = "";
    if (qBox && qBox.value.trim() && !hidden.value) msg = "Pick the party from the list (or clear the box for a cash sale).";
    if (!msg) table.querySelectorAll("tr.line").forEach(function (tr) {
      if (msg || tr.querySelector(".serial-box").hidden) return;
      var n = tokens(tr).length, q = num(tr.querySelector(".f-qty"));
      if (n !== q) msg = "Enter exactly " + q + " IMEI number(s) for " + tr.querySelector(".f-item").selectedOptions[0].text + " (you entered " + n + ").";
    });
    if (!msg && pays) {
      pays.querySelectorAll(".pay").forEach(function (r) {
        if (msg || r.querySelector(".p-mode").value !== "FINANCE") return;
        if (!r.querySelector(".p-fin-in").value.trim()) msg = "Choose the finance company for the FINANCE payment.";
        else if (num(r.querySelector(".p-amt")) <= 0) msg = "Enter the amount disbursed by the finance company.";
      });
      if (!msg && paid() > total + 0.005) msg = "Payments are more than the bill total.";
    }
    if (msg) { e.preventDefault(); alert(msg); }
  });

  document.getElementById("add").addEventListener("click", function () { addLine(); });
  form.addEventListener("input", recalc);
  form.addEventListener("change", recalc);
  var pre = draft ? draft.lines : json("edit-lines", []);
  if (pre.length) pre.forEach(addLine); else addLine();
  if (draft) {
    var hv = function (n, v) {
      var el = form.elements[n]; if (!el || v == null) return;
      if (el.type === "checkbox") el.checked = !!v; else el.value = v;
    };
    Object.keys(draft.head).forEach(function (k) { hv(k, draft.head[k]); });
    var dp = parties.filter(function (p) { return p.id === draft.party.id; })[0];
    if (dp) pick(dp); else if (qBox) qBox.value = draft.party.text || "";
  }
  recalc();

  // remember the form when it is submitted (after the checks above passed)
  form.addEventListener("submit", function (e) {
    if (e.defaultPrevented) return;
    var f = function (n) { var el = form.elements[n]; return el ? (el.type === "checkbox" ? el.checked : el.value) : ""; };
    var snap = {
      url: here, ts: Date.now(),
      head: { date: f("date"), godownId: f("godownId"), placeOfSupply: f("placeOfSupply"), gstEnabled: f("gstEnabled"),
              notes: f("notes"), schemeInfo: f("schemeInfo"), paymentInfo: f("paymentInfo") },
      party: { id: hidden ? hidden.value : "", text: qBox ? qBox.value : "" },
      lines: Array.prototype.map.call(table.querySelectorAll("tr.line"), function (tr) {
        var g = function (c) { return tr.querySelector(c).value; };
        return { itemId: g(".f-item"), description: g("[name=description]"), qty: g(".f-qty"), rate: g(".f-rate"),
                 discountPct: g(".f-disc"), discAmt: g(".f-discamt"), src: tr.dataset.src || "", taxRate: g(".f-tax"),
                 serials: g(".f-serials") };
      }),
      pays: pays ? Array.prototype.map.call(pays.querySelectorAll(".pay"), function (r) {
        return { mode: r.querySelector(".p-mode").value, amount: r.querySelector(".p-amt").value, finance: r.querySelector(".p-fin-in").value };
      }) : []
    };
    try { sessionStorage.setItem(DRAFT, JSON.stringify(snap)); } catch (err) { /* storage unavailable: nothing to keep */ }
  });
})();
