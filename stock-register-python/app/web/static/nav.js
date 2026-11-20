// Sidebar groups (Stock, Billing, Money, Reports, Business): click a heading to hide or show its menu items.
// The choice is remembered in this browser; the group holding the page you are on always opens.
(function () {
  var KEY = "gb-nav-collapsed";
  var groups = document.querySelectorAll(".side .navgrp");
  if (!groups.length) return;
  var read = function () { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { return []; } };
  var write = function (list) { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) {} };
  var collapsed = read();

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
  window.addEventListener("storage", function (e) {  // another tab / the workspace changed it
    if (e.key !== KEY) return;
    var list = read();
    groups.forEach(function (g) { set(g, list.indexOf(g.dataset.group) >= 0 && !g.querySelector("a.on")); });
  });
})();
