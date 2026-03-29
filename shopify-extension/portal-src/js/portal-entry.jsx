// portal-entry.jsx — Preact mount point
import { render } from 'preact';
import App from './App.jsx';
import { configure } from './core/api.js';

function parseJsonAttr(el, attr) {
  try {
    const raw = el?.getAttribute(attr) || '';
    if (!raw) return null;
    return JSON.parse(raw.replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'));
  } catch { return null; }
}

function boot() {
  const root = document.getElementById('subscriptions-portal-root');
  if (!root) return;

  const appEl = document.querySelector('[data-app="subscriptions-portal"]');

  const config = {
    endpoint: appEl?.getAttribute('data-endpoint') || '/apps/portal',
    debug: appEl?.getAttribute('data-debug') === 'true',
    portalPage: appEl?.getAttribute('data-portal-page') || '/pages/portal',
    lockDays: parseInt(appEl?.getAttribute('data-lock-window-days') || '7', 10),
    sellingPlans: {
      week4: appEl?.getAttribute('data-selling-plan-week-4') || '',
      week8: appEl?.getAttribute('data-selling-plan-week-8') || '',
      week2: appEl?.getAttribute('data-selling-plan-week-2') || '',
    },
    shippingProtectionVariantIds: parseJsonAttr(appEl, 'data-shipping-protection-variant-ids') || [],
    catalog: parseJsonAttr(appEl, 'data-products-available-to-add') || [],
    firstName: appEl?.getAttribute('data-first-name') || '',
  };

  configure({ endpoint: config.endpoint, debug: config.debug });

  root.innerHTML = '';
  render(<App config={config} />, root);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
