(function () {
  var script = document.currentScript;
  var workspaceId = script && script.getAttribute("data-workspace");
  if (!workspaceId) return;

  var customerId = script.getAttribute("data-customer-id") || "";
  var customerEmail = script.getAttribute("data-customer-email") || "";
  var customerName = script.getAttribute("data-customer-name") || "";

  // Detect product context from JSON-LD or URL
  var productId = "";
  var productHandle = "";
  try {
    var ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (var i = 0; i < ldScripts.length; i++) {
      var ld = JSON.parse(ldScripts[i].textContent || "{}");
      if (ld["@type"] === "Product" && ld.productID) {
        productId = String(ld.productID);
        break;
      }
      if (ld["@type"] === "Product" && ld.sku) {
        productId = String(ld.sku);
        break;
      }
    }
  } catch (e) {}
  // Fallback: parse /products/handle from URL
  if (!productId) {
    var match = window.location.pathname.match(/\/products\/([^/?#]+)/);
    if (match) productHandle = match[1];
  }

  var BASE = script.src.replace(/\/widget\.js.*$/, "");
  var params = [];
  if (customerId) params.push("cid=" + encodeURIComponent(customerId));
  if (customerEmail) params.push("email=" + encodeURIComponent(customerEmail));
  if (customerName) params.push("name=" + encodeURIComponent(customerName));
  if (productId) params.push("pid=" + encodeURIComponent(productId));
  if (productHandle) params.push("handle=" + encodeURIComponent(productHandle));
  params.push("path=" + encodeURIComponent(window.location.pathname));
  var IFRAME_URL = BASE + "/widget/" + workspaceId + (params.length ? "?" + params.join("&") : "");

  // Create container
  var container = document.createElement("div");
  container.id = "shopcx-chat-widget";
  container.className = "shopcx-widget shopcx-widget-container";
  container.style.cssText =
    "position:fixed;bottom:12px;right:15px;z-index:999999;font-family:system-ui,-apple-system,sans-serif;";

  // The bubble paints before the config fetch resolves, so this default must match
  // the server's default (api/widget/[workspaceId]/config) — otherwise every store
  // without an override flashes one colour and repaints to another. Neutral
  // warm-black: the bubble floats over the merchant's page and must not read as one
  // of their CTAs.
  var DEFAULT_BUBBLE_COLOR = "#33272B";

  // Chat bubble button
  var bubble = document.createElement("button");
  bubble.id = "shopcx-chat-bubble";
  bubble.className = "shopcx-widget shopcx-bubble";
  // The bubble's only content is a decorative SVG, so without these it reaches
  // assistive tech as an unlabelled button — and fails axe/Lighthouse button-name
  // on every page that embeds the widget. type= keeps it inert inside a host form.
  bubble.type = "button";
  bubble.setAttribute("aria-label", "Open chat");
  bubble.setAttribute("aria-expanded", "false");
  bubble.setAttribute("aria-controls", "shopcx-chat-iframe");
  bubble.innerHTML =
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  bubble.style.cssText =
    "width:56px;height:56px;border-radius:50%;border:none;background:" + DEFAULT_BUBBLE_COLOR + ";color:white;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,0.15);transition:transform 0.2s;";
  bubble.onmouseenter = function () {
    bubble.style.transform = "scale(1.05)";
  };
  bubble.onmouseleave = function () {
    bubble.style.transform = "scale(1)";
  };

  // Iframe (hidden initially, and deliberately src-less — see attachIframe).
  // display:none does NOT stop an iframe downloading and booting its document, so
  // assigning src here made every host pageview pay for the whole chat app: ~250KB
  // and ~1.2s of blocked main thread on a mid-range phone, for a panel most
  // visitors never open.
  var iframe = document.createElement("iframe");
  iframe.id = "shopcx-chat-iframe";
  iframe.className = "shopcx-widget shopcx-iframe";
  var isMobile = window.innerWidth <= 480;
  iframe.style.cssText = isMobile
    ? "display:none;position:fixed;top:0;left:0;width:100vw;height:100vh;border:none;border-radius:0;box-shadow:none;background:white;z-index:2147483647;"
    : "display:none;width:380px;height:520px;max-height:calc(100vh - 100px);border:none;border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,0.12);margin-bottom:12px;background:white;";
  iframe.allow = "clipboard-read; clipboard-write";

  var isOpen = false;
  var iframeAttached = false;

  /** Point the iframe at the chat app. Idempotent — safe on any warm signal. */
  function attachIframe() {
    if (iframeAttached) return;
    iframeAttached = true;
    iframe.src = IFRAME_URL;
  }

  var closedIcon = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  var openIcon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

  function setOpen(open) {
    if (open) attachIframe();
    isOpen = open;
    iframe.style.display = isOpen ? "block" : "none";
    bubble.innerHTML = isOpen ? openIcon : closedIcon;
    bubble.setAttribute("aria-label", isOpen ? "Close chat" : "Open chat");
    bubble.setAttribute("aria-expanded", isOpen ? "true" : "false");
    if (isMobile && isOpen) {
      // Move bubble to top-right as a close button over fullscreen iframe
      bubble.style.cssText = "position:fixed;top:12px;right:12px;z-index:2147483648;width:40px;height:40px;border-radius:50%;border:none;background:rgba(0,0,0,0.5);color:white;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:none;";
      // Freeze background scroll
      document.body.style.overflow = "hidden";
      document.body.style.position = "fixed";
      document.body.style.width = "100%";
      document.body.style.top = "-" + window.scrollY + "px";
    } else if (isMobile && !isOpen) {
      // Unfreeze background scroll
      var scrollY = Math.abs(parseInt(document.body.style.top || "0", 10));
      document.body.style.overflow = "";
      document.body.style.position = "";
      document.body.style.width = "";
      document.body.style.top = "";
      window.scrollTo(0, scrollY);
      // Restore to bottom-right bubble with fetched color
      bubble.style.cssText = "width:56px;height:56px;border-radius:50%;border:none;background:" + bubbleColor + ";color:white;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,0.15);transition:transform 0.2s;";
    }
  }

  bubble.onclick = function () { setOpen(!isOpen); };

  // Warm on intent. Hover/touch/focus all precede the click by enough that the
  // chat document is already in flight by the time setOpen runs, so deferring the
  // load costs nothing perceptible on the first open.
  bubble.addEventListener("pointerenter", attachIframe, { once: true });
  bubble.addEventListener("touchstart", attachIframe, { once: true, passive: true });
  bubble.addEventListener("focus", attachIframe, { once: true });

  // Public API — window.ShopCX.open(), .close(), .toggle()
  window.ShopCX = {
    open: function () { setOpen(true); },
    close: function () { setOpen(false); },
    toggle: function () { setOpen(!isOpen); },
    isOpen: function () { return isOpen; },
  };

  var bubbleColor = DEFAULT_BUBBLE_COLOR;

  try {
    var preconnect = document.createElement("link");
    preconnect.rel = "preconnect";
    preconnect.href = BASE;
    preconnect.crossOrigin = "";
    document.head.appendChild(preconnect);
  } catch (e) {}

  // Fetch config for color and position
  fetch(BASE + "/api/widget/" + workspaceId + "/config")
    .then(function (r) {
      return r.json();
    })
    .then(function (cfg) {
      if (cfg.color) {
        bubbleColor = cfg.color;
        bubble.style.background = cfg.color;
      }
      if (cfg.position === "bottom-left") {
        container.style.right = "auto";
        container.style.left = "20px";
      }
    })
    .catch(function () {});

  container.appendChild(iframe);
  container.appendChild(bubble);
  document.body.appendChild(container);
})();
