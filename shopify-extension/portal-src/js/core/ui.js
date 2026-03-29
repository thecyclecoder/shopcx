(function () {
  window.__SP = window.__SP || {};

  function escapeHtml(str) {
    return String(str || "").replace(/[&<>"']/g, function (m) {
      switch (m) {
        case "&": return "&amp;";
        case "<": return "&lt;";
        case ">": return "&gt;";
        case '"': return "&quot;";
        case "'": return "&#039;";
        default: return m;
      }
    });
  }
  function ensurePortalCss() {
    if (document.getElementById("sp-portal-css")) return;
    
  }
  function ensureStyles() {
    ensurePortalCss();
    if (document.getElementById("sp-ui-styles")) return;

  }

  // Compatibility alias for older/newer files
  function ensureBaseStyles() {
    ensureStyles();
  }

  function setRoot(htmlOrEl) {
    ensureStyles();
    var root = window.__SP && window.__SP.root;
    if (!root) return;

    if (typeof htmlOrEl === "string") {
      root.innerHTML = htmlOrEl;
      return;
    }

    // DOM node
    root.innerHTML = "";
    root.appendChild(htmlOrEl);
  }

  function card(innerHtml) {
    return "<div class='sp-card'><div class='sp-wrap'>" + innerHtml + "</div></div>";
  }

  function hero(title, subtitle, pillText) {
    return ""
      + "<div class='sp-hero'>"
      + "  <div class='sp-wrap'>"
      + "    <h2 class='sp-title'>" + escapeHtml(title || "") + "</h2>"
      + "    <p class='sp-muted'>" + escapeHtml(subtitle || "") + "</p>"
      + "  </div>"
      + "  " + (pillText ? "<div class='sp-pill'>" + escapeHtml(pillText) + "</div>" : "")
      + "</div>";
  }

  function stack(parts) {
    parts = Array.isArray(parts) ? parts : [];
    return "<div class='sp-stack'>" + parts.join("") + "</div>";
  }

  // Minimal DOM builder used by portal-subscriptions.js
  function el(tag, attrs, children) {
    ensureStyles();
    var node = document.createElement(tag);

    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === undefined || v === null) return;

      if (k === "class") node.className = String(v);
      else if (k === "style") node.setAttribute("style", String(v));
      else if (k === "href") node.setAttribute("href", String(v));
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, String(v));
    });

    children = Array.isArray(children) ? children : (children != null ? [children] : []);
    children.forEach(function (c) {
      if (c === null || c === undefined) return;
      if (typeof c === "string") node.appendChild(document.createTextNode(c));
      else node.appendChild(c);
    });

    return node;
  }

  function loading(text) {
    var t = text || "Loading…";
    return card("<div style='font-weight:900;font-size:18px;'>" + escapeHtml(t) + "</div>");
  }

  window.__SP.ui = {
    escapeHtml: escapeHtml,
    setRoot: setRoot,
    card: card,
    hero: hero,
    stack: stack,

    // compatibility helpers needed by portal-subscriptions.js
    ensureBaseStyles: ensureBaseStyles,
    ensureStyles: ensureStyles,
    el: el,
    loading: loading
  };

  if (window.__SP && window.__SP.debug) {
    try { console.log("[Portal UI] Loaded. hero/card/stack/setRoot + ensureBaseStyles/el/loading ready."); } catch (e) {}
  }
})();