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
  container.style.cssText =
    "position:fixed;bottom:20px;right:20px;z-index:999999;font-family:system-ui,-apple-system,sans-serif;";

  // Chat bubble button
  var bubble = document.createElement("button");
  bubble.id = "shopcx-chat-bubble";
  bubble.innerHTML =
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  bubble.style.cssText =
    "width:56px;height:56px;border-radius:50%;border:none;background:#4f46e5;color:white;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,0.15);transition:transform 0.2s;";
  bubble.onmouseenter = function () {
    bubble.style.transform = "scale(1.05)";
  };
  bubble.onmouseleave = function () {
    bubble.style.transform = "scale(1)";
  };

  // Iframe (hidden initially)
  var iframe = document.createElement("iframe");
  iframe.src = IFRAME_URL;
  iframe.id = "shopcx-chat-iframe";
  var isMobile = window.innerWidth <= 480;
  iframe.style.cssText = isMobile
    ? "display:none;position:fixed;top:0;left:0;width:100vw;height:100vh;border:none;border-radius:0;box-shadow:none;background:white;z-index:2147483647;"
    : "display:none;width:380px;height:520px;max-height:calc(100vh - 100px);border:none;border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,0.12);margin-bottom:12px;background:white;";
  iframe.allow = "clipboard-read; clipboard-write";

  var isOpen = false;
  var closedIcon = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  var openIcon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

  function setOpen(open) {
    isOpen = open;
    iframe.style.display = isOpen ? "block" : "none";
    bubble.innerHTML = isOpen ? openIcon : closedIcon;
    if (isMobile && isOpen) {
      // Move bubble to top-right as a close button over fullscreen iframe
      bubble.style.cssText = "position:fixed;top:12px;right:12px;z-index:2147483648;width:40px;height:40px;border-radius:50%;border:none;background:rgba(0,0,0,0.5);color:white;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:none;";
    } else if (isMobile && !isOpen) {
      // Restore to bottom-right bubble
      bubble.style.cssText = "width:56px;height:56px;border-radius:50%;border:none;background:#4f46e5;color:white;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,0.15);transition:transform 0.2s;";
    }
  }

  bubble.onclick = function () { setOpen(!isOpen); };

  // Public API — window.ShopCX.open(), .close(), .toggle()
  window.ShopCX = {
    open: function () { setOpen(true); },
    close: function () { setOpen(false); },
    toggle: function () { setOpen(!isOpen); },
    isOpen: function () { return isOpen; },
  };

  // Fetch config for color and position
  fetch(BASE + "/api/widget/" + workspaceId + "/config")
    .then(function (r) {
      return r.json();
    })
    .then(function (cfg) {
      if (cfg.color) {
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
