#!/usr/bin/env node
/**
 * Builds both portal bundles:
 * 1. Shopify extension portal (endpoint: /apps/portal-v2)
 * 2. Mini-site portal (endpoint: /api/portal)
 *
 * Run this after any changes to shopify-extension/portal-src/.
 */
const { execSync } = require('child_process');
const path = require('path');

const extDir = path.join(__dirname, '..', 'shopify-extension');

console.log('=== Building Shopify extension portal ===');
execSync('node build-portal.js', { stdio: 'inherit', cwd: extDir });
execSync(
  'npx sass portal-src/styles/portal.scss extensions/subscriptions-portal-theme/assets/portal.min.css --style=compressed --no-source-map',
  { stdio: 'inherit', cwd: extDir },
);

console.log('\n=== Building mini-site portal ===');
execSync('node scripts/build-minisite-portal.js', { stdio: 'inherit', cwd: path.join(__dirname, '..') });

console.log('\nAll portal builds complete.');
