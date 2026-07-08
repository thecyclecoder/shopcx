/**
 * Persona-avatar auto-generator + backfill — the "no imageless agent" step for Phase 2 of
 * docs/brain/specs/builder-persona-add-upserts-by-key-and-generates-avatar.md.
 *
 * Scans `PERSONAS` in `src/lib/agents/personas.ts` for entries WITHOUT `avatarUrl` (imageless
 * agents that would render as the neutral mascot fallback), and for each:
 *   1) If the `agent-avatars` public Supabase bucket ALREADY has `<name-lower>-<key>.jpg`, reuse it
 *      (idempotent — a re-run after a partial success doesn't regenerate).
 *   2) Else calls `generateNanoBananaProCombine` in `src/lib/gemini.ts` (Nano Banana Pro) with the
 *      canonical AVATAR STYLE preamble from personas.ts + a role-appropriate distinctive-look line
 *      derived from the persona's name / role / pronouns, uploads to `agent-avatars` at
 *      `<name-lower>-<key>.jpg`.
 *   3) Patches the persona's entry in `src/lib/agents/personas.ts` to add
 *      `avatarUrl: \`${AV}<name-lower>-<key>.jpg?v=1\`` right after `mascotId:` on the same line
 *      (mirroring the sibling workers' style).
 *
 * Idempotent by construction: a persona whose runtime `PERSONAS[key].avatarUrl` is already set is
 * skipped entirely (no gen, no upload, no patch). A persona whose bucket file exists but whose
 * entry lacks `avatarUrl` gets a source-only patch (no re-gen). Safe to re-run.
 *
 * The builder's persona-add mandate (durable item G in Bo's prompt at `scripts/builder-worker.ts`)
 * points Bo at this script — after adding a new `PERSONAS[<key>]` entry, running this script
 * generates + wires the headshot so the org chart never renders an imageless persona (the 2026-07-07
 * Prue + earlier Sol/Cora incidents).
 *
 * ⚠️ Prod credentials required (Gemini API key on workspace + Supabase service-role):
 *   - Gemini: comes from `workspaces.gemini_api_key_encrypted` on the ad-tool workspace
 *     (WS below), or `GEMINI_API_KEY` env.
 *   - Supabase: `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` env.
 *
 * Run:  npx tsx scripts/_gen-persona-avatars-backfill.ts
 *       npx tsx scripts/_gen-persona-avatars-backfill.ts --dry-run   # report only, no gen/upload/patch
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { createClient } from "@supabase/supabase-js";
import { generateNanoBananaProCombine } from "../src/lib/gemini";
import { PERSONAS, type AgentPersona } from "../src/lib/agents/personas";

/** ad-tool workspace — has the Gemini API key credential. Same WS used by every avatar-gen one-off. */
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const BUCKET = "agent-avatars";
const REPO_ROOT = join(__dirname, "..");
const PERSONAS_FILE = join(REPO_ROOT, "src/lib/agents/personas.ts");

/** Canonical AVATAR STYLE preamble — mirrors the header comment at the top of personas.ts. */
const HOUSE_STYLE =
  "A PHOTOREALISTIC portrait PHOTOGRAPH of a real-looking person — tight CLOSE CROP (top of head at the top of the frame, cropped just below the collarbone; the face fills the frame), looking at camera, soft editorial lighting, plain neutral background. STYLISH, fashion-forward with real personal taste — modern distinctive outfit, hair, and energy. NOT a boring corporate headshot: NO blazers, NO stiff LinkedIn vibe. Give a genuinely distinctive look, visually distinct from generic corporate portraits. NEVER a cartoon / illustration / 3D render / stylized art; NO cheesy props or gimmicks.";

/** Compose the persona-specific distinctive-look line from the runtime persona (name + role + pronouns). */
function distinctiveLookLine(p: AgentPersona): string {
  const s = p.pronouns?.subject ?? "they";
  const o = p.pronouns?.object ?? "them";
  const g = s === "he" ? "man" : s === "she" ? "woman" : "person";
  return `The subject is ${p.name}, a ${g}, in the role of ${p.role}. Style ${o} to visually read the ${p.role} energy — memorable, distinct from other same-role portraits. Personality cue: ${p.personality}`;
}

/** Slugify a persona name for the filename: lower-case, non-alnum → hyphen. */
function nameSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function fileExistsInBucket(sb: ReturnType<typeof createClient>, name: string): Promise<boolean> {
  const res = await sb.storage.from(BUCKET).list("", { limit: 1000 });
  if (res.error) throw new Error(`bucket_list_${BUCKET}: ${res.error.message}`);
  return (res.data ?? []).some((f) => f.name === name);
}

/**
 * Patch personas.ts: for the given persona `key`, add
 * `avatarUrl: \`${AV}<filename>?v=1\`` right after its `mascotId: "..."` field on the same line.
 * Returns the new source (or the original unchanged if no match — with a warning).
 */
function patchPersonaAvatarUrl(source: string, key: string, filename: string): { patched: string; matched: boolean } {
  const keyEsc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Scope: from `<key>: {` (bareword OR quoted) up to the first `mascotId: "..."` inside its body,
  // which must NOT already be followed by an `avatarUrl` on the same line (defensive — the caller
  // already filtered by runtime `!p.avatarUrl`, so this is belt-and-suspenders against a source
  // that has `avatarUrl: undefined` explicitly).
  const re = new RegExp(
    `("?${keyEsc}"?:\\s*\\{[\\s\\S]*?)mascotId:\\s*("[^"]+")(?!,\\s*avatarUrl)(,)`,
  );
  const patched = source.replace(re, (_m, pre, mv, comma) =>
    // Result: `mascotId: "<val>", avatarUrl: \`${AV}<file>?v=1\`,` — one line, trailing comma.
    `${pre}mascotId: ${mv}${comma} avatarUrl: \`\${AV}${filename}?v=1\`,`,
  );
  return { patched, matched: patched !== source };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!dryRun && (!supabaseUrl || !svcKey)) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (secrets missing on this environment)");
  }
  const sb = !dryRun ? createClient(supabaseUrl!, svcKey!) : null;

  const source = readFileSync(PERSONAS_FILE, "utf8");
  let patched = source;

  const imageless = Object.entries(PERSONAS)
    .filter(([, p]) => !p.avatarUrl)
    .map(([key, p]) => ({ key, p, filename: `${nameSlug(p.name)}-${key}.jpg` }));

  if (imageless.length === 0) {
    console.log("✓ every PERSONAS entry already carries an avatarUrl — nothing to backfill");
    return;
  }

  console.log(
    `backfilling ${imageless.length} imageless persona(s)${dryRun ? " [DRY RUN]" : ""}: ` +
    imageless.map((x) => `${x.key} → ${x.filename}`).join(", "),
  );

  let regenerated = 0;
  let reused = 0;
  let patchedCount = 0;
  const unmatched: string[] = [];

  for (const { key, p, filename } of imageless) {
    let exists = false;
    if (!dryRun && sb) {
      exists = await fileExistsInBucket(sb, filename);
    }
    if (exists) {
      console.log(`  · ${key} → bucket already has ${filename}, reusing`);
      reused++;
    } else if (dryRun) {
      console.log(`  · ${key} → would generate ${filename} via Nano Banana Pro`);
    } else if (sb) {
      const prompt = `${HOUSE_STYLE}\n\n${distinctiveLookLine(p)}`;
      console.log(`  · ${key} → generating ${filename} via Nano Banana Pro …`);
      const { buffer, mimeType } = await generateNanoBananaProCombine({
        workspaceId: WS,
        prompt,
        imageUrls: [],
        aspectRatio: "1:1",
      });
      const upload = await sb.storage.from(BUCKET).upload(filename, buffer, { contentType: mimeType, upsert: true });
      if (upload.error) throw new Error(`upload_${filename}: ${upload.error.message}`);
      console.log(`    ↳ uploaded ${buffer.length} bytes (${mimeType})`);
      regenerated++;
    }

    const r = patchPersonaAvatarUrl(patched, key, filename);
    if (r.matched) {
      patched = r.patched;
      patchedCount++;
    } else {
      unmatched.push(key);
      console.warn(
        `  ! could not locate the \`mascotId:\` line in personas.ts for key=${key}; upload succeeded, ` +
        `but you need to add manually:  avatarUrl: \`\${AV}${filename}?v=1\``,
      );
    }
  }

  if (!dryRun && patched !== source) {
    writeFileSync(PERSONAS_FILE, patched);
    console.log(`✓ patched ${PERSONAS_FILE} — added avatarUrl to ${patchedCount} entry/entries`);
  } else if (dryRun && patched !== source) {
    console.log(`[DRY RUN] would patch ${PERSONAS_FILE} — ${patchedCount} entry/entries`);
  }

  console.log(
    `done — total=${imageless.length}, regenerated=${regenerated}, reused-from-bucket=${reused}, ` +
    `patched=${patchedCount}${unmatched.length ? `, unmatched=${unmatched.join(",")}` : ""}${dryRun ? " [DRY RUN — nothing mutated]" : ""}`,
  );
}

main().catch((e) => {
  console.error("ERR", e instanceof Error ? e.message : e);
  process.exit(1);
});
