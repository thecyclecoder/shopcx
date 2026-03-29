// assets/portal-utils.js
(function () {
  window.__SP = window.__SP || {};
  window.__SP.utils = window.__SP.utils || {};

  // -------------------------------------------------------------------------
  // Core primitives
  // -------------------------------------------------------------------------

  function safeStr(v) {
    return typeof v === "string" ? v : v == null ? "" : String(v);
  }

  function shortId(gid) {
    var s = safeStr(gid);
    if (!s) return "";
    var parts = s.split("/");
    return parts[parts.length - 1] || s;
  }

  function normalizeStatus(s) {
    return safeStr(s).trim().toUpperCase();
  }

  function fmtDate(iso) {
    if (!iso) return "";
    var t = Date.parse(iso);
    if (!isFinite(t)) return "";
    try {
      return new Intl.DateTimeFormat("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }).format(new Date(t));
    } catch (e) {
      try {
        return new Date(t).toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
        });
      } catch (_) {
        return new Date(t).toDateString();
      }
    }
  }

  function money(m) {
    // MoneyV2: { amount: "0.0", currencyCode:"USD" }
    if (!m || m.amount == null) return "";
    var code = m.currencyCode ? safeStr(m.currencyCode) : "USD";
    var n = Number(m.amount);
    if (!isFinite(n))
      return "$" + safeStr(m.amount) + (code && code !== "USD" ? " " + code : "");
    return "$" + n.toFixed(2) + (code && code !== "USD" ? " " + code : "");
  }

  function toMoney(n) {
    var x = Number(n);
    if (!isFinite(x)) return "";
    return "$" + x.toFixed(2);
  }

  function getLinePrice(ln) {
    try {
      if (ln && ln.currentPrice && ln.currentPrice.amount != null)
        return Number(ln.currentPrice.amount);
    } catch (e) {}
    try {
      if (ln && ln.lineDiscountedPrice && ln.lineDiscountedPrice.amount != null)
        return Number(ln.lineDiscountedPrice.amount);
    } catch (e) {}
    return NaN;
  }

  // -------------------------------------------------------------------------
  // Contract shape normalization (ONLY contract-external + portalState)
  // -------------------------------------------------------------------------

  function ensurePortalState(ps) {
    if (ps && typeof ps === "object") return ps;

    return {
      bucket: "other",
      isSoftPaused: false,
      lastAction: "",
      pauseDays: "",
      pausedUntil: "",
      lastActionAt: "",

      // NEW: attention flags
      needsAttention: false,
      attentionReason: "",
      attentionMessage: "",
    };
  }

  function normalizeContract(contract) {
    if (!contract || typeof contract !== "object") return null;

    // normalize lines to a simple array for the UI
    if (contract.lines && Array.isArray(contract.lines.nodes)) {
      contract.lines = contract.lines.nodes;
    } else if (!Array.isArray(contract.lines)) {
      contract.lines = [];
    }

    // portalState is expected from subscriptions.ts; ensure it exists as an object
    contract.portalState = ensurePortalState(contract.portalState);

    // convenience fields
    contract.__shortId = shortId(contract.id);
    contract.status = normalizeStatus(contract.status);

    // convenience derived
    contract.__bucket = safeStr(contract.portalState.bucket || "other").toLowerCase();
    contract.__softPaused = !!contract.portalState.isSoftPaused;

    // NEW: customer-facing "needs attention" helpers
    contract.__needsAttention = !!contract.portalState.needsAttention;
    contract.__attentionMessage = safeStr(contract.portalState.attentionMessage);
    contract.__attentionReason = safeStr(contract.portalState.attentionReason);

    return contract;
  }

  function normalizeContracts(list) {
    if (!Array.isArray(list)) return [];
    return list.map(normalizeContract).filter(Boolean);
  }

  // -------------------------------------------------------------------------
  // Payload helpers (ONLY subscriptions.ts output)
  // -------------------------------------------------------------------------

  function pickContracts(payload) {
    if (!payload || typeof payload !== "object") return [];
    return normalizeContracts(Array.isArray(payload.contracts) ? payload.contracts : []);
  }

  function pickBuckets(payload) {
    if (!payload || typeof payload !== "object") {
      return { active: [], paused: [], cancelled: [], other: [] };
    }

    var b = payload.buckets && typeof payload.buckets === "object" ? payload.buckets : {};
    return {
      active: normalizeContracts(Array.isArray(b.active) ? b.active : []),
      paused: normalizeContracts(Array.isArray(b.paused) ? b.paused : []),
      cancelled: normalizeContracts(Array.isArray(b.cancelled) ? b.cancelled : []),
      other: normalizeContracts(Array.isArray(b.other) ? b.other : []),
    };
  }

  // -------------------------------------------------------------------------
  // State helpers (use portalState first, as produced by subscriptions.ts)
  // -------------------------------------------------------------------------

  function isSoftPaused(contract) {
    return !!(contract && contract.portalState && contract.portalState.isSoftPaused);
  }

  function getPausedUntilLabel(contract) {
    // NOTE: subscriptions.ts currently sets portalState.pausedUntil from attrs.portal_paused_until
    var iso = contract && contract.portalState ? safeStr(contract.portalState.pausedUntil) : "";
    return iso ? fmtDate(iso) : "";
  }

  function bucket(contract) {
    return safeStr(
      contract && contract.portalState && contract.portalState.bucket
        ? contract.portalState.bucket
        : "other"
    ).toLowerCase();
  }

  function needsAttention(contract) {
    return !!(contract && contract.portalState && contract.portalState.needsAttention);
  }

  function attentionMessage(contract) {
    return safeStr(contract && contract.portalState ? contract.portalState.attentionMessage : "");
  }

  function attentionReason(contract) {
    return safeStr(contract && contract.portalState ? contract.portalState.attentionReason : "");
  }

  // -------------------------------------------------------------------------
  // Line helpers
  // -------------------------------------------------------------------------

  function isShippingProtectionLine(ln) {
    var title = safeStr((ln && ln.title) || "").trim().toLowerCase();
    var sku = safeStr((ln && ln.sku) || "").trim().toLowerCase();
    if (title === "shipping protection") return true;
    if (sku && sku.indexOf("insure") >= 0) return true;
    if (sku.indexOf("shipping") >= 0 && sku.indexOf("protect") >= 0) return true;
    return false;
  }

  function billingLabel(policy) {
    var interval = policy && policy.interval ? safeStr(policy.interval).toUpperCase() : "";
    var count = policy && policy.intervalCount != null ? Number(policy.intervalCount) : NaN;

    if (interval === "WEEK") {
      if (count === 4) return "Monthly";
      if (count === 8) return "Every 2 Months";
      if (count === 2) return "Twice a Month";
    }

    if (interval && isFinite(count) && count > 0) {
      return String(count) + " " + interval.toLowerCase() + (count > 1 ? "s" : "");
    }
    return "";
  }

  // -------------------------------------------------------------------------
  // Exports
  // -------------------------------------------------------------------------

  var u = window.__SP.utils;

  u.safeStr = safeStr;
  u.shortId = shortId;
  u.normalizeStatus = normalizeStatus;

  u.fmtDate = fmtDate;
  u.money = money;
  u.toMoney = toMoney;
  u.getLinePrice = getLinePrice;

  u.normalizeContract = normalizeContract;
  u.normalizeContracts = normalizeContracts;

  u.pickContracts = pickContracts;
  u.pickBuckets = pickBuckets;

  u.isSoftPaused = isSoftPaused;
  u.getPausedUntilLabel = getPausedUntilLabel;
  u.bucket = bucket;

  // NEW exports
  u.needsAttention = needsAttention;
  u.attentionMessage = attentionMessage;
  u.attentionReason = attentionReason;

  u.isShippingProtectionLine = isShippingProtectionLine;
  u.billingLabel = billingLabel;

  if (window.__SP && window.__SP.debug) {
    try {
      console.log("[Portal Utils] Loaded (active/paused/cancelled + attention):", Object.keys(window.__SP.utils));
    } catch (e) {}
  }
})();