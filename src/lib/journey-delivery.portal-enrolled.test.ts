/**
 * Portal-enrollment guard for portal-deliverable self-service journeys — spec
 * docs/brain/specs/journeys-enrolled-on-portal-so-sol-june-stop-wrong-escalating.md.
 *
 * Sol/June's channel-eligibility filter (`channelMatches` in cx-agent-sdk.ts) only
 * offers a journey on a portal ticket when 'portal' is in `journey_definitions.channels`.
 * Portal delivery is fully built (`journey-delivery.ts`'s `effectiveChannel === 'portal'`
 * branch: CTA bubble in the portal thread + emailed to the customer). The gap that
 * wrongly escalated Natalie's medical-hardship cancel on 2026-07-30 was CONFIG, not
 * capability — the cancel journey's `channels` array omitted 'portal' so the agents
 * never saw it as an option on a portal ticket and escalated to the founder.
 *
 * This test is the DURABLE guard: any NEW migration (authored on or after the spec
 * grandfather cutoff) that seeds a journey_definition whose slug/trigger_intent is in
 * PORTAL_DELIVERABLE_JOURNEY_INTENTS MUST include 'portal' in the channels ARRAY[...]
 * literal, otherwise Sol/June would silently fail to offer that journey on portal
 * tickets. Older seeds are grandfathered — the ship-time backfill
 * `scripts/_backfill-portal-journey-channels.ts` handles the existing rows.
 *
 * Run:
 *   npx tsx --test src/lib/journey-delivery.portal-enrolled.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { PORTAL_DELIVERABLE_JOURNEY_INTENTS } from "./journey-delivery";

const MIGRATIONS_DIR = resolve(process.cwd(), "supabase", "migrations");

// Migrations authored before this timestamp are grandfathered — they pre-date
// the portal-enrollment rule and are cleaned up by the ship-time backfill.
// Migrations authored on or after this timestamp MUST include 'portal' in
// channels for every portal-deliverable self-service journey they seed.
const GRANDFATHER_TS = "20260730000000";

interface SeedRow {
  file: string;
  slug: string | null;
  triggerIntent: string | null;
  channelsRaw: string;
  isActive: boolean;
  block: string;
}

/**
 * Return every `INSERT INTO journey_definitions ...` statement in `sql` as
 * separate blocks (statement-terminated by the first `;` on its own line
 * or the end of file). Handles both bare `INSERT INTO journey_definitions`
 * and `INSERT INTO public.journey_definitions`.
 */
function findJourneyDefinitionInserts(sql: string): string[] {
  const blocks: string[] = [];
  const re = /INSERT\s+INTO\s+(?:public\.)?journey_definitions\b[\s\S]*?;/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) blocks.push(m[0]);
  return blocks;
}

/** Extract the string-literal value that follows a positional string in the SELECT/VALUES row. */
function extractStringLiterals(block: string): string[] {
  // Single-quoted string literals; escape ('') is not used in our seeds.
  const out: string[] = [];
  const re = /'([^']*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) out.push(m[1]);
  return out;
}

/** Extract the `ARRAY[...]` literal for the channels column in a seed row. */
function extractChannelsArray(block: string): string | null {
  const m = block.match(/ARRAY\s*\[[^\]]*\]/i);
  return m ? m[0] : null;
}

/** True iff the literal contains 'portal' as one of its elements. */
function channelsIncludePortal(channelsRaw: string): boolean {
  // `ARRAY['email','chat','sms','portal']` — element quoting is always single-quotes.
  return /'\s*portal\s*'/.test(channelsRaw);
}

/**
 * Parse a single `INSERT INTO journey_definitions (...) SELECT|VALUES ...` block
 * into (slug, trigger_intent, channels, is_active). Both the SELECT and VALUES
 * forms use positional string literals for slug + trigger_intent so a positional
 * grep of the string literals plus the ARRAY[] literal is enough — no full SQL
 * parser needed. The seed migrations in this repo all follow the shape:
 *   INSERT INTO journey_definitions (workspace_id, slug, name, journey_type,
 *      trigger_intent, description, config, channels, is_active, priority)
 *      SELECT ..., 'slug', 'name', 'type', 'trigger_intent', 'desc',
 *             '{}', ARRAY['email','chat','sms','portal'], true, 50 ...
 */
function parseSeedRow(file: string, block: string): SeedRow | null {
  // Grab the column list to sanity-check the schema shape.
  const cols = block.match(/journey_definitions\s*\(([^)]+)\)/i)?.[1] ?? "";
  if (!/slug/i.test(cols) || !/channels/i.test(cols) || !/trigger_intent/i.test(cols)) {
    // Not a shape we can safely parse — surface nothing rather than a false
    // negative. If a future migration reshapes the seed, add a case here.
    return null;
  }
  const channelsRaw = extractChannelsArray(block);
  if (!channelsRaw) return null;
  const literals = extractStringLiterals(block);
  // The chat_journeys → journey_definitions migration selects columns from a
  // sub-query, so positional literals are absent. Skip.
  if (literals.length < 4) return null;
  // Positional layout (columns: workspace_id, slug, name, journey_type,
  // trigger_intent, description, ...). The first literal is the workspace_id
  // UUID; skip UUIDs when locating slug + trigger_intent.
  const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
  const nonUuid = literals.filter((s) => !isUuid(s));
  const slug = nonUuid[0] ?? null;
  const journeyType = nonUuid[2] ?? null;
  const triggerIntent = nonUuid[3] ?? null;
  // is_active is a boolean literal in the SELECT/VALUES row.
  const isActive = /\btrue\b/i.test(block) && !/is_active\s*=\s*false/i.test(block);
  void journeyType;
  return { file, slug, triggerIntent, channelsRaw, isActive, block };
}

function scanMigrationsForOffenders(): SeedRow[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const portalIntents = new Set<string>(PORTAL_DELIVERABLE_JOURNEY_INTENTS as readonly string[]);
  const offenders: SeedRow[] = [];
  for (const file of files) {
    const ts = file.slice(0, 14);
    if (ts < GRANDFATHER_TS) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    for (const block of findJourneyDefinitionInserts(sql)) {
      const row = parseSeedRow(file, block);
      if (!row) continue;
      if (!row.isActive) continue;
      if (!row.triggerIntent || !portalIntents.has(row.triggerIntent)) continue;
      if (channelsIncludePortal(row.channelsRaw)) continue;
      offenders.push(row);
    }
  }
  return offenders;
}

test("no migration authored on/after 2026-07-30 seeds a portal-deliverable journey without 'portal' in channels", () => {
  const offenders = scanMigrationsForOffenders();
  if (offenders.length === 0) return;
  const detail = offenders
    .map(
      (o) =>
        `  • ${o.file}  slug='${o.slug}'  trigger_intent='${o.triggerIntent}'  channels=${o.channelsRaw}`,
    )
    .join("\n");
  assert.fail(
    `\nFound ${offenders.length} seed row(s) for portal-deliverable self-service journeys ` +
      `missing 'portal' in channels — Sol/June's channelMatches filter will silently skip these ` +
      `on portal tickets and escalate to the founder. Add 'portal' to the ARRAY[...] channels literal.\n\n` +
      `Portal-deliverable trigger_intents: ${PORTAL_DELIVERABLE_JOURNEY_INTENTS.join(", ")}\n\n` +
      detail +
      `\n\nSee src/lib/journey-delivery.ts (PORTAL_DELIVERABLE_JOURNEY_INTENTS) and the portal branch\n` +
      `of launchJourneyForTicketInner for the source of truth.\n`,
  );
});

test("PORTAL_DELIVERABLE_JOURNEY_INTENTS is a non-empty, unique, snake_case list", () => {
  const arr = PORTAL_DELIVERABLE_JOURNEY_INTENTS as readonly string[];
  assert.ok(arr.length > 0, "constant is empty");
  const seen = new Set<string>();
  for (const intent of arr) {
    assert.ok(/^[a-z0-9_]+$/.test(intent), `not snake_case: '${intent}'`);
    assert.ok(!seen.has(intent), `duplicate intent: '${intent}'`);
    seen.add(intent);
  }
  // Crisis-tier journeys are deliberately email-only (proactive outreach, not
  // portal self-service). Guard against them slipping into the constant.
  for (const intent of arr) {
    assert.ok(!/^crisis_/.test(intent), `crisis_* intents must not be in the portal-deliverable list: '${intent}'`);
  }
});
