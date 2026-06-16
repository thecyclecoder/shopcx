/**
 * Reconcile the theme's GitHub repo with the LIVE Shopify theme.
 *
 * Manual edits made in the Shopify code editor / customizer can leave the
 * GitHub repo behind. Before ShopCX starts committing forward (which deploys),
 * the repo must match live or the first commit would revert those edits.
 *
 * This exports every file of the live MAIN theme and commits the ones whose
 * CONTENT differs from the repo (compared by git blob SHA — exact bytes, so no
 * line-ending false positives). It only ADDS/UPDATES — it never deletes repo
 * files missing from live (the repo also holds non-theme files: README, .md
 * playbooks, etc.), so deletions are left for manual review.
 *
 *   npx tsx scripts/reconcile-shopify-theme.ts            # dry run (default)
 *   npx tsx scripts/reconcile-shopify-theme.ts --commit   # commit the diff
 *
 * Workspace defaults to the Superfoods workspace; override with WS=<uuid>.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) for (const line of readFileSync(envPath, "utf8").split("\n")) { const t = line.trim(); if (!t || t.startsWith("#")) continue; const eq = t.indexOf("="); if (eq < 0) continue; const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1); }

const WS = process.env.WS || "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const COMMIT = process.argv.includes("--commit");

/** git blob SHA-1 of a buffer: sha1("blob <len>\0<bytes>"). */
function blobSha(buf: Buffer): string {
  const h = createHash("sha1");
  h.update(`blob ${buf.length}\0`);
  h.update(buf);
  return h.digest("hex");
}

/** Canonical JSON (recursively sorted keys) so we compare meaning, not Shopify's
 *  serialization (key order / whitespace / unicode escaping) vs the repo's. */
function canonicalJson(s: string): string | null {
  try {
    // Shopify serves theme JSON (locales/templates/sections/config) as JSONC
    // with a leading "/* IMPORTANT: auto-generated */" header. Strip a leading
    // block comment so we compare the actual JSON, not the header.
    s = s.replace(/^﻿?\s*\/\*[\s\S]*?\*\/\s*/, "");
    const sort = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(sort)
        : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]))
        : v;
    return JSON.stringify(sort(JSON.parse(s)));
  } catch { return null; }
}

(async () => {
  const { getLiveTheme, listLiveThemeFiles, listRepoFiles, readThemeFile, commitThemeFiles } = await import("../src/lib/shopify-theme");

  const live = await getLiveTheme(WS);
  console.log(`Live theme: ${live.name} (${live.id})`);
  console.log(`GitHub target: ${live.target.owner}/${live.target.repo}@${live.target.branch}`);

  console.log("\nExporting live theme files…");
  const liveFiles = await listLiveThemeFiles(WS, live.id);
  console.log(`  ${liveFiles.length} files on the live theme`);

  console.log("Reading repo tree…");
  const repo = await listRepoFiles(live.target); // path -> blob sha
  console.log(`  ${repo.size} files in the repo`);

  // Diff: live file whose bytes don't match the repo's blob (or is new).
  // For JSON, drop byte-only differences (Shopify reserializes JSON) — keep a
  // file only if its parsed content actually differs from the repo's.
  const changed: { path: string; content?: string; contentBase64?: string; kind: "new" | "modified" }[] = [];
  let jsonFormattingSkipped = 0;
  for (const f of liveFiles) {
    const buf = f.isBinary ? Buffer.from(f.content, "base64") : Buffer.from(f.content, "utf8");
    const liveSha = blobSha(buf);
    const repoSha = repo.get(f.path);
    if (repoSha === liveSha) continue; // identical bytes
    if (!f.isBinary && f.path.endsWith(".json") && repoSha) {
      const repoContent = await readThemeFile(live.target, f.path);
      if (repoContent != null) {
        const a = canonicalJson(f.content), b = canonicalJson(repoContent);
        if (a != null && b != null && a === b) { jsonFormattingSkipped++; continue; } // same meaning, just reserialized
      }
    }
    changed.push({
      path: f.path,
      kind: repoSha ? "modified" : "new",
      ...(f.isBinary ? { contentBase64: f.content } : { content: f.content }),
    });
  }
  if (jsonFormattingSkipped) console.log(`  (skipped ${jsonFormattingSkipped} JSON files that differ only by serialization)`);

  const modified = changed.filter((c) => c.kind === "modified");
  const added = changed.filter((c) => c.kind === "new");
  console.log(`\n=== DIFF (live → repo) ===`);
  console.log(`  ${modified.length} modified, ${added.length} new on live, ${liveFiles.length - changed.length} identical`);
  for (const c of [...modified, ...added].slice(0, 60)) console.log(`  ${c.kind === "new" ? "+" : "~"} ${c.path}`);
  if (changed.length > 60) console.log(`  … and ${changed.length - 60} more`);

  // Sanity guard: if nearly everything "differs", it's almost certainly an
  // export/encoding artifact, not real drift — refuse to commit.
  if (changed.length > liveFiles.length * 0.5 && liveFiles.length > 10) {
    console.log(`\n⚠️  ${changed.length}/${liveFiles.length} files differ — that's suspiciously high (likely an encoding artifact, not real manual edits). NOT committing. Investigate before --commit.`);
    return;
  }

  if (!changed.length) { console.log("\n✅ Repo already matches live — nothing to reconcile."); return; }

  if (!COMMIT) {
    console.log(`\n(dry run) Re-run with --commit to push these ${changed.length} files to ${live.target.repo}@${live.target.branch}.`);
    return;
  }

  console.log(`\nCommitting ${changed.length} files to ${live.target.repo}@${live.target.branch}…`);
  const msg = `Reconcile: live theme manual edits (export from MAIN ${live.id.split("/").pop()})\n\n${modified.length} modified, ${added.length} new. Catches the repo up to the live theme before ShopCX manages it.`;
  const res = await commitThemeFiles(live.target, changed.map((c) => ({ path: c.path, content: c.content, contentBase64: c.contentBase64 })), msg);
  console.log(`  committed ${res.commitSha.slice(0, 8)} — ${res.url}`);
  console.log("\nDONE. The repo now matches live for these files. Re-run this script (dry run) to confirm 0 remaining diff.");
  console.log("Note: the deploy is a no-op — we committed live's own current content, so the live store is unchanged.");
})().catch((e) => console.error("ERR:", e.message, e.stack));
