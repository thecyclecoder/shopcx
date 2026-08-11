/**
 * CEO-inbox signal-to-noise hot fix (2026-08-11) — pins the one-open-card-per-stuck-build dedupe.
 *
 * Regression this guards (measured on the live inbox 2026-08-11): 27 open CEO approval cards
 * resolved to only 14 real incidents — a 1.93x fan-out. One failing spec
 * (`scope-subscription-item-sync-by-workspace`) held FOUR cards, because four watchdogs each mint
 * into their OWN dedupe namespace (parkbackstop / initguard / escort-failed-repeat /
 * groom-loopguard) and two of them were byte-identical because `parkbackstop` keys on the JOB id,
 * so a build retry minted a second card for the same failure.
 *
 *   npx tsx --test src/lib/agents/approval-inbox.build-stuck-dedupe.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  BUILD_STUCK_ESCALATION_NAMESPACES,
  dedupeNamespace,
  openBuildStuckCardExistsForSpec,
} from "./approval-inbox";

type Card = { metadata: Record<string, unknown> | null };

/** Minimal admin stub: one `dashboard_notifications` select chain returning the given cards. */
function stubAdmin(cards: Card[], opts: { error?: string } = {}) {
  return {
    from() {
      const chain = {
        select() {
          return chain;
        },
        eq() {
          return chain;
        },
        limit() {
          return Promise.resolve(
            opts.error ? { data: null, error: { message: opts.error } } : { data: cards, error: null },
          );
        },
      };
      return chain;
    },
  } as unknown as Parameters<typeof openBuildStuckCardExistsForSpec>[0];
}

const card = (dedupeKey: string, specSlug: string | null): Card => ({
  metadata: { dedupe_key: dedupeKey, spec_slug: specSlug },
});

test("dedupeNamespace — splits on the first colon, tolerates a key with none", () => {
  assert.equal(dedupeNamespace("parkbackstop:8f21-uuid"), "parkbackstop");
  assert.equal(dedupeNamespace("escort-failed-repeat:my-spec"), "escort-failed-repeat");
  assert.equal(dedupeNamespace("bare-key"), "bare-key");
});

test("the six build-stuck namespaces are all recognized as the same incident family", () => {
  for (const ns of ["parkbackstop", "needsattn", "initguard", "groom-loopguard", "escort-failed-repeat", "loopguard"]) {
    assert.ok(BUILD_STUCK_ESCALATION_NAMESPACES.has(ns), `${ns} must be in the family`);
  }
});

test("a sibling watchdog's card for the SAME spec suppresses a second card", async () => {
  // The exact 2026-08-11 shape: initguard already has a card; escort-failed-repeat must not add one.
  const admin = stubAdmin([card("initguard:scope-subscription-item-sync-by-workspace", "scope-subscription-item-sync-by-workspace")]);
  const exists = await openBuildStuckCardExistsForSpec(
    admin,
    "ws-1",
    "scope-subscription-item-sync-by-workspace",
    "escort-failed-repeat:scope-subscription-item-sync-by-workspace",
  );
  assert.equal(exists, true);
});

test("a job-keyed parkbackstop card is matched by spec_slug, so a RETRY cannot mint a duplicate", async () => {
  // parkbackstop keys on the job id, which differs per build attempt — the spec_slug is what makes
  // the two attempts recognizably the same incident.
  const admin = stubAdmin([card("parkbackstop:job-aaa", "scope-create-return-order-to-ticket-customer")]);
  const exists = await openBuildStuckCardExistsForSpec(
    admin,
    "ws-1",
    "scope-create-return-order-to-ticket-customer",
    "parkbackstop:job-bbb", // a NEW job row for the same failing spec
  );
  assert.equal(exists, true);
});

test("the caller's OWN key is excluded, so its bump/re-mint path still works", async () => {
  const admin = stubAdmin([card("initguard:my-spec", "my-spec")]);
  const exists = await openBuildStuckCardExistsForSpec(admin, "ws-1", "my-spec", "initguard:my-spec");
  assert.equal(exists, false);
});

test("a card for a DIFFERENT spec never suppresses this one", async () => {
  const admin = stubAdmin([card("initguard:other-spec", "other-spec")]);
  assert.equal(await openBuildStuckCardExistsForSpec(admin, "ws-1", "my-spec", "parkbackstop:job-1"), false);
});

test("a non-build-stuck card (a real founder decision) never suppresses a build-stuck escalation", async () => {
  // A storefront campaign approval on the same spec is a different KIND of decision — it must not
  // silence a genuine "your build is stuck" signal.
  const admin = stubAdmin([card("storefront-campaign:my-spec", "my-spec")]);
  assert.equal(await openBuildStuckCardExistsForSpec(admin, "ws-1", "my-spec", "initguard:my-spec"), false);
});

test("no spec slug → falls back to the job-scoped dedup (never suppresses)", async () => {
  const admin = stubAdmin([card("initguard:my-spec", "my-spec")]);
  assert.equal(await openBuildStuckCardExistsForSpec(admin, "ws-1", null, "parkbackstop:job-1"), false);
});

test("FAIL-OPEN: a read error returns false — a rare duplicate beats a suppressed escalation", async () => {
  const admin = stubAdmin([], { error: "connection reset" });
  assert.equal(await openBuildStuckCardExistsForSpec(admin, "ws-1", "my-spec", "initguard:my-spec"), false);
});
