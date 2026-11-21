// Sidebar groups (Stock, Billing, Money, Reports, Business): click a heading to hide or show its menu items.
// The choice is remembered in this browser; the group holding the page you are on always opens.
(function () {
  var KEY = "gb-nav-collapsed";
  var groups = document.querySelectorAll(".side .navgrp:not(.sub)");
  if (!groups.length) return;
  var read = function () { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { return []; } };
  var write = function (list) { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) {} };
  var collapsed = read();
  var side = document.querySelector(".side");
  side.classList.add("nonav");  // no slide while the saved state is applied

  function set(g, hide) {
    g.classList.toggle("collapsed", hide);
    g.querySelector(".grp").setAttribute("aria-expanded", String(!hide));
  }

  groups.forEach(function (g) {
    var name = g.dataset.group;
    set(g, collapsed.indexOf(name) >= 0 && !g.querySelector("a.on"));  // never hide where you are
    g.querySelector(".grp").addEventListener("click", function () {
      var hide = !g.classList.contains("collapsed");
      set(g, hide);
      var list = read().filter(function (n) { return n !== name; });
      if (hide) list.push(name);
      write(list);
    });
  });

  // ---- sub groups: the items open in a panel to the right of the sidebar while the pointer (or keyboard focus) is on the sub group
  var subs = document.querySelectorAll(".side .navgrp.sub");
  var phone = window.matchMedia("(max-width:760px)");
  var timer = null;
  function closeAll(except) {
    subs.forEach(function (s) { if (s !== except) s.classList.remove("open"); });
  }
  function place(s) {
    var head = s.querySelector(".grp"), panel = s.querySelector(".navitems");
    var h = head.getBoundingClientRect(), sd = side.getBoundingClientRect();
    panel.style.left = (sd.right + 6) + "px";
    var top = h.top - 8, ph = panel.offsetHeight;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, window.innerHeight - ph - 8);
    panel.style.top = Math.max(8, top) + "px";
  }
  function open(s) {
    if (phone.matches) return;
    clearTimeout(timer);
    closeAll(s);
    s.classList.add("open");
    place(s);
  }
  function scheduleClose(s) {
    clearTimeout(timer);
    timer = setTimeout(function () { s.classList.remove("open"); }, 220);  // a short grace so the pointer can cross the gap to the panel
  }
  subs.forEach(function (s) {
    if (s.querySelector("a.on")) s.classList.add("has-on");  // show which sub group holds the page you are on
    s.addEventListener("mouseenter", function () { open(s); });
    s.addEventListener("mouseleave", function () { scheduleClose(s); });
    s.addEventListener("focusin", function () { open(s); });
    s.addEventListener("focusout", function (e) { if (!s.contains(e.relatedTarget)) scheduleClose(s); });
    s.querySelector(".grp").addEventListener("click", function () {  // touch / keyboard: tap the heading to open or close
      if (phone.matches) return;
      if (s.classList.contains("open")) s.classList.remove("open"); else open(s);
    });
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeAll(null); });
  document.addEventListener("scroll", function (e) {  // scrolling the page closes a fly-out; scrolling inside the panel itself does not
    if (e.target && e.target.closest && e.target.closest(".navgrp.sub .navitems")) return;
    closeAll(null);
  }, true);
  window.addEventListener("resize", function () { closeAll(null); });
  requestAnimationFrame(function () { requestAnimationFrame(function () { side.classList.remove("nonav"); }); });
  window.addEventListener("storage", function (e) {  // another tab / the workspace changed it
    if (e.key !== KEY) return;
    var list = read();
    groups.forEach(function (g) { set(g, list.indexOf(g.dataset.group) >= 0 && !g.querySelector("a.on")); });
  });
})();
