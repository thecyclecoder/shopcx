// assets/subscription-portal.js
(function () {
  function log() {
    try {
      if (window.__SP && window.__SP.debug) {
        console.log.apply(console, arguments);
      }
    } catch (e) {}
  }

  function init(el) {
    var root = el.querySelector("#subscriptions-portal-root");
    if (!root) return;

    var endpoint = el.getAttribute("data-endpoint") || "/apps/portal";
    var portalPage = el.getAttribute("data-portal-page") || "/pages/portal";
    var debug = el.getAttribute("data-debug") === "true";
    var isDesignMode = document.documentElement.classList.contains("shopify-design-mode");

    

    function wireLocationChangeEvent() {
      if (window.__SP && window.__SP.__wiredLocationChange) return;
      window.__SP = window.__SP || {};
      window.__SP.__wiredLocationChange = true;

      function emit() {
        try {
          window.dispatchEvent(new Event("sp:locationchange"));
        } catch (e) {}
      }

      ["pushState", "replaceState"].forEach(function (fn) {
        var orig = history[fn];
        if (!orig) return;
        history[fn] = function () {
          var ret = orig.apply(this, arguments);
          emit();
          return ret;
        };
      });

      window.addEventListener("popstate", emit);
      window.addEventListener("hashchange", emit);
    }

    wireLocationChangeEvent();

    // ---- Config parsing (unchanged) ----
    function getAttrAny(el, names) {
      for (var i = 0; i < names.length; i++) {
        var v = el.getAttribute(names[i]);
        if (v !== null && v !== undefined && String(v).trim() !== "") return v;
      }
      return "";
    }

    function toInt(val, fallback) {
      var n = parseInt(String(val || "").trim(), 10);
      return isFinite(n) ? n : fallback;
    }

    function cleanStr(val) {
      return String(val == null ? "" : val).trim();
    }

    function parseList(val) {
      var s = cleanStr(val);
      if (!s) return [];

      if ((s[0] === "[" && s[s.length - 1] === "]") || (s[0] === "{" && s[s.length - 1] === "}")) {
        try {
          var parsed = JSON.parse(s);
          if (Array.isArray(parsed)) {
            return parsed.map(function (x) { return cleanStr(x); }).filter(Boolean);
          }
        } catch (_) {}
      }

      return s.split(",").map(function (x) { return cleanStr(x); }).filter(Boolean);
    }

    function parsePortalConfig(el) {
      var raw = {
        lock_window_days: getAttrAny(el, ["data-lock-window-days", "data-lock_window_days", "data-config-lock-window-days"]),
        selling_plan_week_4: getAttrAny(el, ["data-selling-plan-week-4", "data-selling_plan_week_4", "data-selling-plan-week4"]),
        selling_plan_week_8: getAttrAny(el, ["data-selling-plan-week-8", "data-selling_plan_week_8", "data-selling-plan-week8"]),
        selling_plan_week_2: getAttrAny(el, ["data-selling-plan-week-2", "data-selling_plan_week_2", "data-selling-plan-week2"]),

        shipping_protection_product: getAttrAny(el, [
          "data-shipping-protection-product",
          "data-shipping_protection_product",
          "data-shipping-protection-product-id"
        ]),

        shipping_protection_variant_ids: getAttrAny(el, [
          "data-shipping-protection-variant-ids",
          "data-shipping_protection_variant_ids",
          "data-shipping-protection-variants",
          "data-shipping-protection-variant-ids-json"
        ]),

        products_available_to_add: getAttrAny(el, [
          "data-products-available-to-add",
          "data-products_available_to_add",
          "data-products-add"
        ]),

        addons: getAttrAny(el, ["data-addons", "data-addon-products", "data-addons-products"]),

        products_available_to_add_variant_ids: getAttrAny(el, [
          "data-products-available-to-add-variant-ids",
          "data-products_available_to_add_variant_ids",
          "data-products-add-variant-ids",
          "data-products-available-variant-ids"
        ]),

        addons_variant_ids: getAttrAny(el, [
          "data-addons-variant-ids",
          "data-addons_variant_ids",
          "data-addon-variant-ids",
          "data-addon-variants"
        ])
      };

      var cfg = {
        lockWindowDays: toInt(raw.lock_window_days, 7),
        sellingPlans: {
          week4: cleanStr(raw.selling_plan_week_4),
          week8: cleanStr(raw.selling_plan_week_8),
          week2: cleanStr(raw.selling_plan_week_2)
        },
        shippingProtectionProduct: cleanStr(raw.shipping_protection_product),
        shippingProtectionVariantIds: parseList(raw.shipping_protection_variant_ids),
        productsAvailableToAdd: parseList(raw.products_available_to_add),
        addons: parseList(raw.addons),
        productsAvailableToAddVariantIds: parseList(raw.products_available_to_add_variant_ids),
        addonsVariantIds: parseList(raw.addons_variant_ids)
      };

      return { raw: raw, config: cfg };
    }

    // Global config for bundle modules
    window.__SP = window.__SP || {};
    window.__SP.endpoint = endpoint;
    window.__SP.portalPage = portalPage;
    window.__SP.debug = debug;
    window.__SP.isDesignMode = isDesignMode;
    window.__SP.root = root;
    window.__SP.el = el;

    var parsed = parsePortalConfig(el);
    window.__SP.configRaw = parsed.raw;
    window.__SP.config = parsed.config;

    log("[Portal Config] raw:", window.__SP.configRaw);
    log("[Portal Config] normalized:", window.__SP.config);

    if (isDesignMode) {
      root.innerHTML = "<p style='color:#6b7280;'>Preview mode: subscription data loads on the live storefront.</p>";
      return;
    }

    root.innerHTML = "<p style='text-align: center;'>Loading...</p>";

    function getAssetBase() {
      var scripts = document.getElementsByTagName("script");
      for (var i = scripts.length - 1; i >= 0; i--) {
        var src = scripts[i] && scripts[i].getAttribute && scripts[i].getAttribute("src");
        if (!src) continue;
        if (src.indexOf("subscription-portal.js") >= 0) {
          return src.replace(/subscription-portal\.js.*$/, "");
        }
      }
      return "/";
    }

    function loadScript(url) {
      return new Promise(function (resolve, reject) {
        var s = document.createElement("script");
        s.src = url;
        s.async = true;
        s.onload = function () { resolve(); };
        s.onerror = function (e) { reject(e); };
        document.head.appendChild(s);
      });
    }

    // ---- Breadcrumb shell ----------------------------------------------------

    function normalizePortalPage(p) {
      p = String(p || "/pages/portal");
      return p.replace(/\/+$/, "");
    }

    function getPortalPageBase() {
      return normalizePortalPage((window.__SP && window.__SP.portalPage) ? window.__SP.portalPage : portalPage);
    }

    function navTo(url, opts) {
      opts = opts || {};
      url = String(url || "");
      if (!url) return;

      try {
        if (opts.replace) window.history.replaceState({}, "", url);
        else window.history.pushState({}, "", url);
      } catch (e) {
        window.location.href = url;
        return;
      }

      try { window.dispatchEvent(new Event("popstate")); } catch (e2) {}
    }

    function currentPortalScreen() {
      var base = getPortalPageBase(); // "/pages/portal"
      var path = String(window.location.pathname || "");
      if (path.indexOf(base) !== 0) return "other";

      var tail = path.slice(base.length);
      tail = String(tail || "").replace(/^\/+/, "");

      if (!tail) return "home";
      if (tail.indexOf("subscriptions") === 0) return "subscriptions";
      if (tail.indexOf("subscription") === 0) return "subscription-detail";
      return "other";
    }

    function subscriptionsUrlFromHere() {
      var base = getPortalPageBase();
      var params = new URLSearchParams(window.location.search || "");
      var status = (params.get("status") || "active").toLowerCase();
      return base + "/subscriptions?status=" + encodeURIComponent(status);
    }

function profileIconSvg(ui) {
  var ns = "http://www.w3.org/2000/svg";

  // Use ui.el for the HTML wrapper (fine in HTML namespace)
  var wrap = ui.el("span", { class: "sp-bc__icon", "aria-hidden": "true" }, []);

  // Build SVG with correct namespace
  var svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.style.display = "block"; // avoids baseline weirdness

  var path1 = document.createElementNS(ns, "path");
  path1.setAttribute("d", "M20 21a8 8 0 0 0-16 0");
  path1.setAttribute("stroke", "currentColor");
  path1.setAttribute("stroke-width", "2");
  path1.setAttribute("stroke-linecap", "round");
  path1.setAttribute("stroke-linejoin", "round");

  var path2 = document.createElementNS(ns, "path");
  path2.setAttribute("d", "M12 13a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z");
  path2.setAttribute("stroke", "currentColor");
  path2.setAttribute("stroke-width", "2");
  path2.setAttribute("stroke-linecap", "round");
  path2.setAttribute("stroke-linejoin", "round");

  svg.appendChild(path1);
  svg.appendChild(path2);
  wrap.appendChild(svg);

  return wrap;
}



    function renderBreadcrumb(ui) {
  var screen = currentPortalScreen();
  var base = getPortalPageBase();
  var ordersUrl = "https://account.superfoodscompany.com/orders";

  function link(href, textOrNodes, onClick) {
    var props = { href: href, class: "sp-bc__a" };
    if (typeof onClick === "function") {
      props.onclick = function (e) {
        try { e.preventDefault(); } catch (_) {}
        onClick();
      };
    }
    return ui.el("a", props, Array.isArray(textOrNodes) ? textOrNodes : [textOrNodes]);
  }

  function sep() {
    return ui.el("span", { class: "sp-bc__sep" }, ["→"]);
  }

  // Icon is always clickable
  var iconLink = link(ordersUrl, [profileIconSvg(ui)]);

  // HOME: icon → Manager (current, not clickable). No Subscriptions.
  if (screen === "home") {
    return ui.el("div", { class: "sp-bc__wrap" }, [
      ui.el("div", { class: "sp-bc" }, [
        iconLink,
        sep(),
        ui.el("span", { class: "sp-bc__cur" }, ["Manager"]),
      ]),
    ]);
  }

  // Manager is clickable everywhere except home
  var managerLink = link(base, "Manager", function () { navTo(base); });

  // SUBSCRIPTIONS LIST: Subscriptions is current (not clickable)
  if (screen === "subscriptions") {
    return ui.el("div", { class: "sp-bc__wrap" }, [
      ui.el("div", { class: "sp-bc" }, [
        iconLink,
        sep(),
        managerLink,
        sep(),
        ui.el("span", { class: "sp-bc__cur" }, ["Subscriptions"]),
      ]),
    ]);
  }

  // DETAIL: Subscriptions clickable, then View current
  if (screen === "subscription-detail") {
    var subsUrl = subscriptionsUrlFromHere();
    var subsLink = link(subsUrl, "Subscriptions", function () { navTo(subsUrl); });

    return ui.el("div", { class: "sp-bc__wrap" }, [
      ui.el("div", { class: "sp-bc" }, [
        iconLink,
        sep(),
        managerLink,
        sep(),
        subsLink,
        sep(),
        ui.el("span", { class: "sp-bc__cur" }, ["View"]),
      ]),
    ]);
  }

  // Fallback for any other portal screen: icon → Manager (current)
  return ui.el("div", { class: "sp-bc__wrap" }, [
    ui.el("div", { class: "sp-bc" }, [
      iconLink,
      sep(),
      ui.el("span", { class: "sp-bc__cur" }, ["Manager"]),
    ]),
  ]);
}

    function mountShellWithBreadcrumb() {
      var ui = window.__SP && window.__SP.ui;
      if (!ui || typeof ui.el !== "function") return;

      // If shell already exists, just refresh breadcrumb content and ensure screen root exists.
      var existing = root.querySelector(".sp-app");
      if (existing) {
        var bcMount = root.querySelector("#sp-breadcrumb-root");
        if (bcMount) {
          bcMount.innerHTML = "";
          bcMount.appendChild(renderBreadcrumb(ui));
        }
        return;
      }

      var app = ui.el("div", { class: "sp-app" }, [
        ui.el("div", { id: "sp-breadcrumb-root" }, [renderBreadcrumb(ui)]),
        ui.el("div", { id: "sp-screen-root" }, [])
      ]);

      root.innerHTML = "";
      root.appendChild(app);

      // Allow screens to render ONLY inside #sp-screen-root
      window.__SP.setScreenRoot = function (htmlOrEl) {
        var target = document.getElementById("sp-screen-root");
        if (!target) return;

        if (typeof htmlOrEl === "string") {
          target.innerHTML = htmlOrEl;
          return;
        }

        target.innerHTML = "";
        target.appendChild(htmlOrEl);
      };

      // Wrap ui.setRoot so existing screens render into #sp-screen-root
      if (ui && typeof ui.setRoot === "function" && !ui.__sp_wrapped_setRoot) {
        var originalSetRoot = ui.setRoot;
        ui.setRoot = function (htmlOrEl) {
          if (window.__SP && typeof window.__SP.setScreenRoot === "function") {
            window.__SP.setScreenRoot(htmlOrEl);
            return;
          }
          return originalSetRoot(htmlOrEl);
        };
        ui.__sp_wrapped_setRoot = true;
      }

      // Re-render breadcrumb on navigation
      window.addEventListener("sp:locationchange", function () {
        try {
          var bc = document.getElementById("sp-breadcrumb-root");
          if (!bc) return;
          bc.innerHTML = "";
          bc.appendChild(renderBreadcrumb(ui));
        } catch (e) {}
      });
    }

    // ---- Boot ---------------------------------------------------------------

    var base = getAssetBase();
    log("[Subscriptions Portal] assetBase:", base);
    log("[Subscriptions Portal] endpoint:", endpoint);
    log("[Subscriptions Portal] portalPage:", portalPage);

    // Load ONE bundled file
    loadScript(base + "portal.bundle.js")
      .then(function () {
        // Ensure breadcrumb shell exists before router renders screens
        mountShellWithBreadcrumb();

        if (window.__SP && window.__SP.router && typeof window.__SP.router.start === "function") {
          window.__SP.router.start();
          return;
        }

        root.innerHTML = "<p>Portal bundle loaded, but router was not initialized.</p>";
      })
      .catch(function (err) {
        console.error("[Subscriptions Portal] Boot error:", err);
        root.innerHTML = "<p>Could not load portal. Please refresh. If this keeps happening, contact support.</p>";
      });
  }

  function boot() {
    document
      .querySelectorAll('[data-app="subscriptions-portal"]')
      .forEach(function (el) { init(el); });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  document.addEventListener("shopify:section:load", boot);
})();