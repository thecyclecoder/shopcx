#!/usr/bin/env node
/**
 * Builds the portal JS/CSS for the mini-site (non-Shopify) context.
 * Uses the same source files as the Shopify extension but with
 * endpoint set to /api/portal (for the Next.js-hosted portal).
 *
 * Output: public/portal-assets/subscription-portal.js + portal.min.css
 * Does NOT modify anything in shopify-extension/.
 */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const extDir = path.join(__dirname, '..', 'shopify-extension');
const portalSrc = path.join(extDir, 'portal-src');
const outDir = path.join(__dirname, '..', 'public', 'portal-assets');

// Ensure output dir exists
fs.mkdirSync(outDir, { recursive: true });

const outJs = path.join(outDir, 'subscription-portal.js');
const outCss = path.join(outDir, 'portal.min.css');
const scssIn = path.join(portalSrc, 'styles', 'portal.scss');

// Build JS — endpoint is /api/portal for the minisite
const cmd = [
  `npx esbuild ${path.join(portalSrc, 'js', 'portal-entry.jsx')}`,
  '--bundle --format=iife --platform=browser --target=es2018',
  '--jsx=automatic --jsx-import-source=preact',
  `--define:__PORTAL_ENDPOINT__='"/api/portal"'`,
  `--outfile=${outJs}`,
  '--minify',
].join(' ');

console.log('[build-minisite-portal] Building JS (endpoint: /api/portal)...');
execSync(cmd, { stdio: 'inherit', cwd: extDir });

// Build CSS
console.log('[build-minisite-portal] Building CSS...');
execSync(`npx sass ${scssIn} ${outCss} --style=compressed --no-source-map`, {
  stdio: 'inherit',
  cwd: extDir,
});

console.log('[build-minisite-portal] Done.');
console.log(`  JS: ${outJs}`);
console.log(`  CSS: ${outCss}`);
