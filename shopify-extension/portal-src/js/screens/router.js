// assets/portal-router.js
(function () {
  window.__SP = window.__SP || {};

  function getPortalBase() {
    var p = (window.__SP && window.__SP.portalPage) ? String(window.__SP.portalPage) : "/pages/portal";
    return p.replace(/\/+$/, ""); // strip trailing slash
  }

  function safeRender(screenKey) {
    var ui = window.__SP.ui;
    var screens = window.__SP.screens || {};
    var screen = screens[screenKey];

    if (screen && typeof screen.render === "function") {
      return screen.render();
    }

    try { console.warn("[Portal Router] Missing screen:", screenKey, screen); } catch (e) {}

    if (ui) {
      ui.setRoot(
        ui.card(
          "<div class='sp-wrap'>" +
            "<h2 class='sp-title'>Loading…</h2>" +
            "<p class='sp-muted'>The portal is still loading. Please refresh.</p>" +
            (window.__SP.debug ? "<p class='sp-muted'>Missing screen: <code>" + screenKey + "</code></p>" : "") +
          "</div>"
        )
      );
    }
  }

  function start() {
    if (!window.__SP.root) return;

    // Render on back/forward
    window.addEventListener("popstate", route);

    // Render on SPA nav events emitted by subscriptions-portal.js
    window.addEventListener("sp:locationchange", route);

    // Intercept in-portal links (base-aware)
    document.addEventListener("click", function (e) {
      var a = e.target && e.target.closest ? e.target.closest("a") : null;
      if (!a) return;

      var href = a.getAttribute("href") || "";
      if (!href) return;

      var base = getPortalBase();

      // Only intercept links that navigate inside the portal base path
      if (href.indexOf(base) !== 0) return;

      e.preventDefault();
      try {
        window.history.pushState({}, "", href);
      } catch (_) {
        window.location.href = href;
        return;
      }

      route();
    });

    route();
  }

  function route() {
    var base = getPortalBase();
    var path = String(window.location.pathname || "");

    // Normalize: strip trailing slash so "/pages/portal/" becomes "/pages/portal"
    path = path.replace(/\/+$/, "");

    if (path === base) return safeRender("home");
    if (path.indexOf(base + "/subscriptions") === 0) return safeRender("subscriptions");

     // Detail page is always base + "/subscription"
    // We also allow "intent" to select sub-screens without changing pathname.
    if (path === base + "/subscription") {
      var intent = "";
      try {
        var sp = new URLSearchParams(window.location.search || "");
        intent = String(sp.get("intent") || "").trim().toLowerCase();
      } catch (e) {}

      if (intent === "cancel") return safeRender("cancel");
      return safeRender("subscriptionDetail");
    }

    if (window.__SP.ui) {
      window.__SP.ui.setRoot(
        window.__SP.ui.card(
          "<div class='sp-wrap'><h2 class='sp-title'>Not found</h2><p class='sp-muted'>That portal page does not exist.</p></div>"
        )
      );
    }
  }

  window.__SP.router = { start: start };
})();