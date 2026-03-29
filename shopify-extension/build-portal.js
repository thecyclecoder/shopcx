#!/usr/bin/env node
// build-portal.js — Reads proxy path from shopify.app.toml and builds the portal JS
const { execSync } = require('child_process');
const fs = require('fs');

const toml = fs.readFileSync('shopify.app.toml', 'utf8');

const prefix = (toml.match(/prefix\s*=\s*"([^"]+)"/)?.[1]) || 'apps';
const subpath = (toml.match(/subpath\s*=\s*"([^"]+)"/)?.[1]) || 'portal';
const endpoint = `/${prefix}/${subpath}`;

const isWatch = process.argv.includes('--watch');

const cmd = [
  'npx esbuild portal-src/js/portal-entry.jsx',
  '--bundle --format=iife --platform=browser --target=es2018',
  '--jsx=automatic --jsx-import-source=preact',
  `--define:__PORTAL_ENDPOINT__='"${endpoint}"'`,
  '--outfile=extensions/subscriptions-portal-theme/assets/subscription-portal.js',
  isWatch ? '--sourcemap --watch' : '--minify',
].join(' ');

console.log(`[build-portal] endpoint: ${endpoint}`);
execSync(cmd, { stdio: 'inherit' });
