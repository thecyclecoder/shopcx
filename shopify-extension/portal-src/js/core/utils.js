// core/utils.js — Utility functions (ES module)

export function safeStr(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

export function shortId(gid) {
  const s = safeStr(gid);
  if (!s) return '';
  const parts = s.split('/');
  return parts[parts.length - 1] || s;
}

export function normalizeStatus(s) {
  return safeStr(s).trim().toUpperCase();
}

export function fmtDate(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!isFinite(t)) return '';
  try {
    return new Intl.DateTimeFormat('en-US', {
      year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
    }).format(new Date(t));
  } catch {
    return new Date(t).toDateString();
  }
}

export function money(m) {
  if (!m || m.amount == null) return '';
  const code = m.currencyCode || 'USD';
  const n = Number(m.amount);
  if (!isFinite(n)) return '$' + m.amount;
  return '$' + n.toFixed(2) + (code !== 'USD' ? ' ' + code : '');
}

export function toMoney(n) {
  const x = Number(n);
  return isFinite(x) ? '$' + x.toFixed(2) : '';
}

export function getLinePrice(ln) {
  if (ln?.currentPrice?.amount != null) return Number(ln.currentPrice.amount);
  if (ln?.lineDiscountedPrice?.amount != null) return Number(ln.lineDiscountedPrice.amount);
  return NaN;
}

export function isShippingProtectionLine(ln) {
  const title = safeStr(ln?.title).toLowerCase();
  const sku = safeStr(ln?.sku).toLowerCase();
  if (title === 'shipping protection') return true;
  if (sku.includes('insure')) return true;
  if (sku.includes('shipping') && sku.includes('protect')) return true;
  return false;
}

export function billingLabel(policy) {
  const interval = safeStr(policy?.interval).toUpperCase();
  const count = Number(policy?.intervalCount);

  if (interval === 'WEEK') {
    if (count === 4) return 'Monthly';
    if (count === 8) return 'Every 2 Months';
    if (count === 2) return 'Twice a Month';
  }
  if (interval && isFinite(count) && count > 0) {
    return count + ' ' + interval.toLowerCase() + (count > 1 ? 's' : '');
  }
  return '';
}

export function bucket(contract) {
  const b = safeStr(contract?.portalState?.bucket).toLowerCase();
  if (['active', 'paused', 'cancelled', 'failed', 'other'].includes(b)) return b;

  const status = normalizeStatus(contract?.status);
  const lps = normalizeStatus(contract?.lastPaymentStatus);
  if (status === 'FAILED') return 'failed';
  if (lps && lps !== 'SUCCEEDED') return 'failed';
  if (status === 'CANCELLED') return 'cancelled';
  if (status === 'PAUSED') return 'paused';
  if (status === 'ACTIVE') return 'active';
  return 'other';
}

export function normalizeContract(c) {
  if (!c || typeof c !== 'object') return null;
  if (c.lines?.nodes) c.lines = c.lines.nodes;
  if (!Array.isArray(c.lines)) c.lines = [];
  if (!c.portalState || typeof c.portalState !== 'object') {
    c.portalState = { bucket: 'other', needsAttention: false };
  }
  c.__shortId = shortId(c.id);
  c.status = normalizeStatus(c.status);
  return c;
}

export function normalizeContracts(list) {
  return (list || []).map(normalizeContract).filter(Boolean);
}

export function pickBuckets(payload) {
  if (!payload?.buckets) return { active: [], paused: [], cancelled: [], other: [] };
  const b = payload.buckets;
  return {
    active: normalizeContracts(b.active || []),
    paused: normalizeContracts(b.paused || []),
    cancelled: normalizeContracts(b.cancelled || []),
    other: normalizeContracts(b.other || []),
  };
}

export function splitLines(contract) {
  const all = Array.isArray(contract?.lines) ? contract.lines : [];
  let shipLine = null;
  const lines = [];
  for (const ln of all) {
    if (!ln) continue;
    if (isShippingProtectionLine(ln) && !shipLine) shipLine = ln;
    else lines.push(ln);
  }
  return { lines, shipLine, all };
}

export function getLineImage(ln) {
  return safeStr(ln?.variantImage?.transformedSrc);
}
