(function () {
  window.__SP = window.__SP || {};
  window.__SP.actions = window.__SP.actions || {};

  var __sp_busy = false;

  function shortId(gid) {
    var s = String(gid || "");
    if (!s) return "";
    var parts = s.split("/");
    return parts[parts.length - 1] || s;
  }

  function showToast(ui, text, kind) {
    var cls = "sp-toast";
    if (kind === "success") cls += " sp-toast--success";
    if (kind === "error") cls += " sp-toast--error";

    var toast = ui.el("div", { class: cls, role: "status", "aria-live": "polite" }, [
      ui.el("div", { class: "sp-toast__body" }, [text || ""])
    ]);

    // Mount to <html> so body transforms don't break fixed positioning
    var host = document.documentElement;

    // Remove existing
    var existing = host.querySelector(".sp-toast");
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

    host.appendChild(toast);

    var ttl = 15000;
    window.setTimeout(function () {
      try {
        if (toast && toast.parentNode) toast.parentNode.removeChild(toast);
      } catch (e) {}
    }, ttl);
  }

  function showBlockingModal(ui, text) {
    var overlay = ui.el("div", { class: "sp-modal sp-modal--blocking" }, [
      ui.el("div", { class: "sp-modal__card" }, [
        ui.el("div", { class: "sp-modal__title" }, ["Processing changes…"]),
        ui.el("div", { class: "sp-modal__body sp-muted" }, [text || "Please wait."])
      ])
    ]);

    document.body.appendChild(overlay);
    return function close() {
      try {
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
      } catch (e) {}
    };
  }

  async function withBusy(ui, actionFn, modalText) {
    if (__sp_busy) return { ok: false, error: "busy" };
    __sp_busy = true;

    var close = showBlockingModal(ui, modalText || "Please do not refresh while we update your subscription.");
    try {
      return await actionFn();
    } finally {
      __sp_busy = false;
      close();
    }
  }

  // ---- NEW: subscription cache-first contract resolver --------------------

  // Keep these keys aligned with portal-api.js (subscriptions cache)
  var SUBS_CACHE_KEY = "__sp_subscriptions_cache_v1";

  function readSubscriptionsCache() {
    try {
      var raw = sessionStorage.getItem(SUBS_CACHE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function findContractInPayload(payload, shortContractId) {
    if (!payload || !shortContractId) return null;

    var utils = window.__SP && window.__SP.utils;
    var list = [];

    try {
      if (utils && typeof utils.pickContracts === "function") {
        list = utils.pickContracts(payload);
      } else if (Array.isArray(payload.contracts)) {
        list = payload.contracts;
      }
    } catch (e) {
      list = [];
    }

    if (!Array.isArray(list)) list = [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (!c) continue;
      if (shortId(c.id) === String(shortContractId)) return c;
    }
    return null;
  }

  async function refreshContractByShortId(shortContractId) {
    // 1) Cache-first: subscriptions cache (what detail page uses)
    var entry = readSubscriptionsCache();
    if (entry && entry.data) {
      var fromCache = findContractInPayload(entry.data, shortContractId);
      if (fromCache) return fromCache;
    }

    // 2) Fallback: fetch single contract directly (DO NOT cache it here)
    if (!window.__SP.api || typeof window.__SP.api.requestJson !== "function") return null;

    try {
      // You said this route exists/should exist. This returns ONE contract.
      var resp = await window.__SP.api.requestJson(
        "subscriptionDetail",
        { id: String(shortContractId) },
        { force: true }
      );

      // Allow either { ok:true, contract:{...} } or raw contract
      if (resp && resp.ok === true && resp.contract) return resp.contract;
      if (resp && resp.id) return resp;

      return null;
    } catch (e) {
      return null;
    }
  }

  window.__SP.actions.busy = {
    withBusy: withBusy,
    showToast: showToast,
    refreshContractByShortId: refreshContractByShortId
  };
})();