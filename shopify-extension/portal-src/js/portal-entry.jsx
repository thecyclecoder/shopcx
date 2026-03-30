// portal-entry.jsx — Preact mount point
// Only reads data-workspace from Liquid. Everything else comes from the bootstrap API.
import { render } from 'preact';
import App from './App.jsx';
import { configure, requestJson } from './core/api.js';

async function boot() {
  const root = document.getElementById('subscriptions-portal-root');
  if (!root) return;

  const appEl = document.querySelector('[data-app="subscriptions-portal"]');
  const workspaceId = appEl?.getAttribute('data-workspace') || '';

  // Auto-detect portal page path from current URL
  // e.g. /pages/portal-test → base is /pages/portal-test
  const portalPage = window.location.pathname.replace(/\/(subscriptions|subscription)$/, '').replace(/\/+$/, '') || '/pages/portal';

  // Injected at build time from shopify.app.toml [app_proxy] prefix + subpath
  const endpoint = typeof __PORTAL_ENDPOINT__ !== 'undefined' ? __PORTAL_ENDPOINT__ : '/apps/portal';

  configure({ endpoint });

  const config = {
    workspaceId,
    endpoint,
    portalPage,
    firstName: '',
    lockDays: 7,
    shippingProtectionProductIds: [],
    catalog: [],
    rewardsUrl: '',
    banned: false,
  };

  // Fetch everything from the bootstrap API
  try {
    const bootstrap = await requestJson('bootstrap', {}, { force: true });
    if (bootstrap?.ok) {
      // Customer identity
      if (bootstrap.customer) {
        config.firstName = bootstrap.customer.firstName || '';
      }
      // Workspace portal config
      if (bootstrap.banned) config.banned = true;
      if (bootstrap.config) {
        const c = bootstrap.config;
        config.lockDays = c.lockDays ?? 7;
        config.shippingProtectionProductIds = c.shippingProtectionProductIds ?? [];
        config.catalog = c.catalog ?? [];
        config.rewardsUrl = c.rewardsUrl ?? '';
      }
    }
  } catch (e) {
    console.warn('[Portal] Bootstrap failed:', e);
  }

  root.innerHTML = '';
  render(<App config={config} />, root);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
