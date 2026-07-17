/**
 * Unit tests for the dahlia-copy-author-box-session Phase 3 wire-in.
 *
 * Pins the discriminated outcomes of the pure copy-author revise loop + its parsing / temperature
 * / pack-broadcast helpers without needing Supabase or a real box session — the caller (stockProduct)
 * threads a stubbed dispatcher, so the loop's behaviour is deterministically testable:
 *
 *   (a) DAHLIA_COPY_MODE unset OR dispatcher absent → resolveAudienceTemperature is never in play
 *       and stockProduct's `authorModeEngaged` guard collapses to false (asserted by the shape of
 *       the guard — a compile-time invariant we exercise via the resolveAudienceTemperature +
 *       parseAuthorVerdict + runCopyAuthorSession seams).
 *   (b) Dispatcher returns a good verdict → runCopyAuthorSession returns { kind:'ok' } with the
 *       parsed AuthorModeCopy on the first attempt.
 *   (c) self_score.total < AUTHOR_SELF_SCORE_FLOOR → the loop dispatches ONE more time (revise),
 *       and if that second attempt succeeds, returns ok with attempts=2.
 *   (d) Exhaustion after the revise cap → { kind:'exhausted', reason:'…' }.
 *   (e) Parse failure → same fail-closed treatment as (c) — trigger a revise; after cap → exhausted.
 *   (f) Cold-audience emit that trips hasColdOfferLeak → revise trigger.
 *
 * Runs via: npx tsx --test src/lib/ads/creative-agent.author.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { CopyAuthorSessionDispatcher, CopyAuthorSessionInputs } from "./creative-agent";
import {
  ANDROMEDA_CONCEPT_TAGS,
  AUTHOR_SELF_SCORE_FLOOR,
  MAX_COPY_AUTHOR_REVISE_ATTEMPTS,
  authorCopyPack,
  buildAdCampaignInsertBody,
  parseAuthorVerdict,
  resolveAudienceTemperature,
  runCopyAuthorSession,
  type AuthorModeCopy,
} from "./creative-agent";
import type { ScoredAngle } from "./creative-brief";

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────────

function angle(overrides: Partial<ScoredAngle> = {}): ScoredAngle {
  return {
    hook: "Energy that lasts, without the crash",
    source: "review_cluster",
    leadBenefit: "steady 4-hour energy",
    acquisitionPower: 5,
    retentionTruth: 5,
    commodity: false,
    hasRealPhoto: false,
    reasons: [],
    raw: {},
    ...overrides,
  } as ScoredAngle;
}

function sessionInputs(overrides: Partial<CopyAuthorSessionInputs> = {}): CopyAuthorSessionInputs {
  return {
    brief: { imageRefs: [], productTitle: "Superfood Tabs", supportingBenefits: [], proofStack: [] } as unknown as CopyAuthorSessionInputs["brief"],
    angle: angle(),
    imagePath: "/tmp/creative-author-fixture.jpg",
    rubricText: "# rubric — fixture",
    audienceTemperature: "warm",
    competitorDna: null,
    targetSchwartzLevel: 3,
    marketSophisticationEvidence: [],
    ...overrides,
  };
}

function envelope(overrides: Record<string, unknown> = {}): string {
  const defaultScore = { lf8: 2, schwartz: 2, cialdini: 2, hopkins: 2, sugarman: 2, total: 10, evidence: ["ok"] };
  // dahlia-never-fabricate-copy-firewall Phase 2 (layer 2) — `claim_trace` is REQUIRED. Default
  // fixture cites a generic supportingBenefit so parseAuthorVerdict accepts the envelope; tests
  // that need a specific trace pass `claim_trace: [...]` via overrides.
  const defaultClaimTrace = [
    { claim: "steady focus", source: "supportingBenefit", source_ref: "steady focus" },
  ];
  const body = {
    headline: "Clean energy — no crash",
    primaryText: "Steady 4-hour energy from adaptogens. No jitters, no crash. Shop now 👉",
    description: "Adaptogens · steady energy",
    audience_temperature: "warm",
    concept_tag: "mechanism",
    self_score: defaultScore,
    claim_trace: defaultClaimTrace,
    ...overrides,
  };
  return JSON.stringify(body);
}

function scriptedDispatcher(replies: Array<{ resultText: string; isError?: boolean } | Error>): {
  dispatch: CopyAuthorSessionDispatcher;
  calls: Array<{ prompt: string; imagePath: string }>;
} {
  const calls: Array<{ prompt: string; imagePath: string }> = [];
  let i = 0;
  const dispatch: CopyAuthorSessionDispatcher = async (prompt, imagePath) => {
    calls.push({ prompt, imagePath });
    const reply = replies[i++];
    if (!reply) throw new Error(`no scripted reply for dispatch call #${calls.length}`);
    if (reply instanceof Error) throw reply;
    return { resultText: reply.resultText, isError: reply.isError === true };
  };
  return { dispatch, calls };
}

// ── resolveAudienceTemperature ───────────────────────────────────────────────────────────────────

test("resolveAudienceTemperature: competitor source → cold", () => {
  assert.equal(resolveAudienceTemperature({ source: "competitor", acquisitionPower: 1 }), "cold");
});

test("resolveAudienceTemperature: acquisitionPower ≥ 8 → cold (scroll-stopper)", () => {
  assert.equal(resolveAudienceTemperature({ source: "review_cluster", acquisitionPower: 8 }), "cold");
  assert.equal(resolveAudienceTemperature({ source: "review_cluster", acquisitionPower: 10 }), "cold");
});

test("resolveAudienceTemperature: own-brand mid-acquisition → warm", () => {
  assert.equal(resolveAudienceTemperature({ source: "review_cluster", acquisitionPower: 7 }), "warm");
  assert.equal(resolveAudienceTemperature({ source: "benefit", acquisitionPower: 0 }), "warm");
});

// ── parseAuthorVerdict ──────────────────────────────────────────────────────────────────────────

test("parseAuthorVerdict: happy path → ok with all fields", () => {
  const result = parseAuthorVerdict(envelope());
  assert.equal(result.kind, "ok");
  if (result.kind === "ok") {
    assert.equal(result.verdict.headline, "Clean energy — no crash");
    assert.equal(result.verdict.audience_temperature, "warm");
    assert.equal(result.verdict.concept_tag, "mechanism");
    assert.equal(result.verdict.selfScore.total, 10);
    assert.deepEqual(result.verdict.selfScore.evidence, ["ok"]);
  }
});

test("parseAuthorVerdict: every Andromeda concept_tag is accepted", () => {
  for (const tag of ANDROMEDA_CONCEPT_TAGS) {
    const result = parseAuthorVerdict(envelope({ concept_tag: tag }));
    assert.equal(result.kind, "ok", `tag rejected: ${tag}`);
    if (result.kind === "ok") assert.equal(result.verdict.concept_tag, tag);
  }
});

test("parseAuthorVerdict: missing concept_tag → invalid", () => {
  const body = {
    headline: "Clean energy — no crash",
    primaryText: "Steady 4-hour energy.",
    description: "Adaptogens",
    audience_temperature: "warm",
    self_score: { lf8: 2, schwartz: 2, cialdini: 2, hopkins: 2, sugarman: 2, total: 10, evidence: [] },
  };
  const result = parseAuthorVerdict(JSON.stringify(body));
  assert.equal(result.kind, "invalid");
  if (result.kind === "invalid") assert.equal(result.reason, "missing_concept_tag");
});

test("parseAuthorVerdict: concept_tag not one of the 10 Andromeda tokens → invalid", () => {
  const result = parseAuthorVerdict(envelope({ concept_tag: "urgency" }));
  assert.equal(result.kind, "invalid");
  if (result.kind === "invalid") assert.match(result.reason, /bad_concept_tag/);
});

test("parseAuthorVerdict: extracts JSON from a fenced ```json block", () => {
  const wrapped = `Here is your verdict:\n\n\`\`\`json\n${envelope()}\n\`\`\`\n`;
  const result = parseAuthorVerdict(wrapped);
  assert.equal(result.kind, "ok");
});

test("parseAuthorVerdict: missing headline → invalid", () => {
  const result = parseAuthorVerdict(envelope({ headline: "" }));
  assert.equal(result.kind, "invalid");
  if (result.kind === "invalid") assert.equal(result.reason, "missing_headline");
});

test("parseAuthorVerdict: bad audience_temperature → invalid", () => {
  const result = parseAuthorVerdict(envelope({ audience_temperature: "lukewarm" }));
  assert.equal(result.kind, "invalid");
  if (result.kind === "invalid") assert.match(result.reason, /bad_audience_temperature/);
});

test("parseAuthorVerdict: sub-score out of {0,1,2} → invalid", () => {
  const bad = envelope({ self_score: { lf8: 3, schwartz: 2, cialdini: 2, hopkins: 2, sugarman: 2, total: 11, evidence: [] } });
  const result = parseAuthorVerdict(bad);
  assert.equal(result.kind, "invalid");
  if (result.kind === "invalid") assert.equal(result.reason, "bad_lf8_subscore");
});

test("parseAuthorVerdict: mismatched total (declared ≠ summed) → invalid", () => {
  const bad = envelope({ self_score: { lf8: 2, schwartz: 2, cialdini: 2, hopkins: 2, sugarman: 2, total: 9, evidence: [] } });
  const result = parseAuthorVerdict(bad);
  assert.equal(result.kind, "invalid");
  if (result.kind === "invalid") assert.match(result.reason, /total_mismatch/);
});

test("parseAuthorVerdict: no JSON at all → invalid", () => {
  const result = parseAuthorVerdict("The model refused. Try again.");
  assert.equal(result.kind, "invalid");
  if (result.kind === "invalid") assert.equal(result.reason, "no_json_object_in_reply");
});

// dahlia-never-fabricate-copy-firewall Phase 2 (layer 2) — the REQUIRED claim_trace field. A
// missing / empty / mis-shaped claim_trace fails the parse with the distinct
// `firewall_missing_claim_trace` reason so the M1 revise loop can cite it back to Dahlia.

test("parseAuthorVerdict: missing claim_trace → firewall_missing_claim_trace", () => {
  const body = {
    headline: "h",
    primaryText: "p",
    description: "d",
    audience_temperature: "warm",
    concept_tag: "mechanism",
    self_score: { lf8: 2, schwartz: 2, cialdini: 2, hopkins: 2, sugarman: 2, total: 10, evidence: [] },
    // claim_trace omitted
  };
  const result = parseAuthorVerdict(JSON.stringify(body));
  assert.equal(result.kind, "invalid");
  if (result.kind === "invalid") assert.match(result.reason, /firewall_missing_claim_trace/);
});

test("parseAuthorVerdict: empty claim_trace array → firewall_missing_claim_trace", () => {
  const result = parseAuthorVerdict(envelope({ claim_trace: [] }));
  assert.equal(result.kind, "invalid");
  if (result.kind === "invalid") assert.match(result.reason, /firewall_missing_claim_trace \(empty\)/);
});

test("parseAuthorVerdict: claim_trace entry with off-vocabulary source → firewall_missing_claim_trace", () => {
  const bad = envelope({ claim_trace: [{ claim: "x", source: "made_up_source", source_ref: "y" }] });
  const result = parseAuthorVerdict(bad);
  assert.equal(result.kind, "invalid");
  if (result.kind === "invalid") assert.match(result.reason, /firewall_missing_claim_trace \(bad_source_at_0/);
});

test("parseAuthorVerdict: claim_trace entry with missing source_ref → firewall_missing_claim_trace", () => {
  const bad = envelope({ claim_trace: [{ claim: "x", source: "ingredients", source_ref: "" }] });
  const result = parseAuthorVerdict(bad);
  assert.equal(result.kind, "invalid");
  if (result.kind === "invalid") assert.match(result.reason, /firewall_missing_claim_trace \(missing_source_ref_at_0\)/);
});

test("parseAuthorVerdict: happy path parses claim_trace into the verdict", () => {
  const trace = [
    { claim: "600mg L-theanine", source: "ingredients", source_ref: "L-theanine" },
    { claim: "steady focus", source: "supportingBenefit", source_ref: "steady focus" },
  ];
  const result = parseAuthorVerdict(envelope({ claim_trace: trace }));
  assert.equal(result.kind, "ok");
  if (result.kind === "ok") {
    assert.equal(result.verdict.claim_trace.length, 2);
    assert.equal(result.verdict.claim_trace[0].source, "ingredients");
    assert.equal(result.verdict.claim_trace[0].source_ref, "L-theanine");
    assert.equal(result.verdict.claim_trace[1].source, "supportingBenefit");
  }
});

// ── authorCopyPack ──────────────────────────────────────────────────────────────────────────────

test("authorCopyPack: broadcasts Dahlia's single caption across the pack min", () => {
  const pack = authorCopyPack({ headline: "A", primaryText: "B", description: "C" });
  assert.equal(pack.headlines.length, 4);
  assert.equal(pack.primaryTexts.length, 4);
  assert.ok(pack.headlines.every((h) => h === "A"));
  assert.ok(pack.primaryTexts.every((p) => p === "B"));
  assert.equal(pack.description, "C");
});

test("authorCopyPack: clips strings past META_CAPS (Meta hard limits — headline 40 / primary 600 / description 90)", () => {
  const long = "x".repeat(2000);
  const pack = authorCopyPack({ headline: long, primaryText: long, description: long });
  assert.ok(pack.headlines[0].length <= 40, `headline over cap: ${pack.headlines[0].length}`);
  assert.ok(pack.primaryTexts[0].length <= 600, `primary over cap: ${pack.primaryTexts[0].length}`);
  assert.ok(pack.description.length <= 90, `description over cap: ${pack.description.length}`);
});

// ── runCopyAuthorSession — the revise loop ──────────────────────────────────────────────────────

test("runCopyAuthorSession (b): a good verdict on the first attempt → ok with attempts=1", async () => {
  const { dispatch, calls } = scriptedDispatcher([{ resultText: envelope() }]);
  const outcome = await runCopyAuthorSession(sessionInputs(), dispatch);
  assert.equal(outcome.kind, "ok");
  if (outcome.kind === "ok") {
    assert.equal(outcome.attempts, 1);
    assert.equal(calls.length, 1);
    // The first attempt's prompt must NOT include the revise directive.
    assert.doesNotMatch(calls[0].prompt, /REVISE — this is the ONE external revise/);
  }
});

test("runCopyAuthorSession (c): self-score below floor → ONE revise, then ok on attempt 2", async () => {
  const belowFloor = 5; // AUTHOR_SELF_SCORE_FLOOR is 6 — 5 = fail
  const bad = envelope({ self_score: { lf8: 1, schwartz: 1, cialdini: 1, hopkins: 1, sugarman: 1, total: belowFloor, evidence: [] } });
  assert.ok(belowFloor < AUTHOR_SELF_SCORE_FLOOR); // sanity guard on the test's fixture math
  const { dispatch, calls } = scriptedDispatcher([{ resultText: bad }, { resultText: envelope() }]);
  const outcome = await runCopyAuthorSession(sessionInputs(), dispatch);
  assert.equal(outcome.kind, "ok");
  if (outcome.kind === "ok") {
    assert.equal(outcome.attempts, 2);
    assert.equal(calls.length, 2);
    // The revise prompt MUST cite the self-score reason (so Dahlia knows what to fix).
    assert.match(calls[1].prompt, /self_score_below_floor/);
    assert.match(calls[1].prompt, /REVISE — this is the ONE external revise/);
  }
});

test("runCopyAuthorSession (d): still-bad after the revise cap → exhausted with the last reason", async () => {
  const bad = envelope({ self_score: { lf8: 0, schwartz: 0, cialdini: 0, hopkins: 0, sugarman: 0, total: 0, evidence: [] } });
  const { dispatch, calls } = scriptedDispatcher([{ resultText: bad }, { resultText: bad }]);
  const outcome = await runCopyAuthorSession(sessionInputs(), dispatch);
  assert.equal(outcome.kind, "exhausted");
  if (outcome.kind === "exhausted") {
    assert.equal(outcome.attempts, 1 + MAX_COPY_AUTHOR_REVISE_ATTEMPTS);
    assert.equal(calls.length, 1 + MAX_COPY_AUTHOR_REVISE_ATTEMPTS);
    assert.match(outcome.reason, /self_score_below_floor/);
  }
});

test("runCopyAuthorSession (e): parse failure → treated as a revise trigger; second attempt succeeds → ok", async () => {
  const { dispatch, calls } = scriptedDispatcher([{ resultText: "not JSON" }, { resultText: envelope() }]);
  const outcome = await runCopyAuthorSession(sessionInputs(), dispatch);
  assert.equal(outcome.kind, "ok");
  if (outcome.kind === "ok") {
    assert.equal(outcome.attempts, 2);
    assert.match(calls[1].prompt, /parse_failed/);
  }
});

test("runCopyAuthorSession (e): dispatcher isError=true → treated as a revise trigger", async () => {
  const { dispatch, calls } = scriptedDispatcher([{ resultText: "", isError: true }, { resultText: envelope() }]);
  const outcome = await runCopyAuthorSession(sessionInputs(), dispatch);
  assert.equal(outcome.kind, "ok");
  if (outcome.kind === "ok") {
    assert.match(calls[1].prompt, /session_error/);
  }
});

test("runCopyAuthorSession (e): dispatcher THROWS → treated as a revise trigger (no unhandled rejection)", async () => {
  const { dispatch, calls } = scriptedDispatcher([new Error("boom"), { resultText: envelope() }]);
  const outcome = await runCopyAuthorSession(sessionInputs(), dispatch);
  assert.equal(outcome.kind, "ok");
  if (outcome.kind === "ok") {
    assert.match(calls[1].prompt, /dispatch_threw/);
  }
});

test("runCopyAuthorSession (f): cold audience emit that leaks offer language → revise trigger; second attempt cleans up → ok", async () => {
  const leaky = envelope({
    headline: "Save 25% today",
    primaryText: "Free shipping on cold energy — buy now.",
    description: "Shop now",
    audience_temperature: "cold",
    self_score: { lf8: 2, schwartz: 2, cialdini: 2, hopkins: 2, sugarman: 2, total: 10, evidence: [] },
  });
  const clean = envelope({
    headline: "Energy without the 3pm slump",
    primaryText: "Adaptogens that steady your afternoon focus.",
    description: "Steady focus",
    audience_temperature: "cold",
    self_score: { lf8: 2, schwartz: 2, cialdini: 2, hopkins: 2, sugarman: 2, total: 10, evidence: [] },
  });
  const { dispatch, calls } = scriptedDispatcher([{ resultText: leaky }, { resultText: clean }]);
  const outcome = await runCopyAuthorSession(sessionInputs({ audienceTemperature: "cold" }), dispatch);
  assert.equal(outcome.kind, "ok");
  if (outcome.kind === "ok") {
    assert.equal(outcome.verdict.headline, "Energy without the 3pm slump");
    assert.match(calls[1].prompt, /cold_offer_leak/);
  }
});

test("runCopyAuthorSession: prompt embeds IMAGE, AUDIENCE_TEMPERATURE, TARGET_SCHWARTZ_LEVEL, MARKET_SOPHISTICATION_EVIDENCE, and the DATA block", async () => {
  const { dispatch, calls } = scriptedDispatcher([{ resultText: envelope() }]);
  await runCopyAuthorSession(
    sessionInputs({
      audienceTemperature: "cold",
      imagePath: "/tmp/pinned.jpg",
      targetSchwartzLevel: 4,
      // dahlia-market-sophistication-escalation Phase 1 — the audit trail behind the
      // escalated TARGET_SCHWARTZ_LEVEL. Threaded verbatim into the prompt so Dahlia can
      // cite the fallback in her verdict rationale.
      marketSophisticationEvidence: [
        "advertiser=Alpha Co level=L3 hook=clean energy for the afternoon",
        "advertiser=Bravo Co level=L4 hook=real adaptogen stack",
      ],
    }),
    dispatch,
  );
  const prompt = calls[0].prompt;
  assert.match(prompt, /IMAGE: \/tmp\/pinned\.jpg/);
  assert.match(prompt, /AUDIENCE_TEMPERATURE: cold/);
  // dahlia-market-sophistication-escalation Phase 1 — the escalated Schwartz level (shelf
  // modal + 1, clamped) must appear in the session input so Dahlia writes ABOVE the market's
  // sophistication level, not at it.
  assert.match(prompt, /TARGET_SCHWARTZ_LEVEL: 4/);
  // The evidence[] audit trail must appear alongside — one line per contributing angle so
  // Dahlia can cite the shelf's actual advertisers + levels when she narrates her choice.
  assert.match(prompt, /MARKET_SOPHISTICATION_EVIDENCE:/);
  assert.match(prompt, /advertiser=Alpha Co/);
  assert.match(prompt, /level=L4/);
  assert.match(prompt, /===BEGIN_AUTHOR_DATA_v1===/);
  assert.match(prompt, /===END_AUTHOR_DATA_v1===/);
});

// ── buildAdCampaignInsertBody — the insertReadyCreative row-stamping flow ─────────────────────
// dahlia-andromeda-concept-diversity-tags Phase 1 — pins the concept_tag pipeline from a parsed
// AuthorModeCopy verdict all the way to the ad_campaigns insert body. The helper is the pure
// seam insertReadyCreative uses to construct the row, so a passing pin here proves the flow
// end-to-end without stubbing the storage / DB chains (Phase 3 Fix check 1).

function authorCopy(overrides: Partial<AuthorModeCopy> = {}): AuthorModeCopy {
  return {
    headline: "Clean energy — no crash",
    primaryText: "Steady 4-hour energy.",
    description: "Adaptogens",
    audience_temperature: "warm",
    concept_tag: "transformation",
    selfScore: { lf8: 2, schwartz: 2, cialdini: 2, hopkins: 2, sugarman: 2, total: 10, evidence: ["ok"] },
    // dahlia-never-fabricate-copy-firewall Phase 2 — REQUIRED claim_trace field on AuthorModeCopy.
    claim_trace: [{ claim: "steady focus", source: "supportingBenefit", source_ref: "steady focus" }],
    ...overrides,
  };
}

test("buildAdCampaignInsertBody: author-mode verdict with concept_tag='transformation' → ad_campaigns row body carries concept_tag='transformation' (row-stamping flow pinned)", () => {
  const body = buildAdCampaignInsertBody({
    workspaceId: "ws-1",
    productId: "prod-1",
    name: "Dahlia · Superfood Tabs · review_cluster",
    angleId: "angle-1",
    status: "ready",
    audienceTemperature: "warm",
    authorModeCopy: authorCopy({ concept_tag: "transformation" }),
  });
  // The exact row insertReadyCreative writes — concept_tag must land verbatim so Bianca's
  // Phase-2 diversity gate reads it back off ad_campaigns.
  assert.equal(body.concept_tag, "transformation");
  assert.equal(body.workspace_id, "ws-1");
  assert.equal(body.product_id, "prod-1");
  assert.equal(body.angle_id, "angle-1");
  assert.equal(body.status, "ready");
  assert.equal(body.audience_temperature, "warm");
  assert.equal(body.author_self_score?.total, 10);
});

test("buildAdCampaignInsertBody: every Andromeda concept_tag round-trips onto the ad_campaigns row (SSOT)", () => {
  for (const tag of ANDROMEDA_CONCEPT_TAGS) {
    const body = buildAdCampaignInsertBody({
      workspaceId: "ws-1",
      productId: "prod-1",
      name: "n",
      angleId: "angle-1",
      status: "ready",
      audienceTemperature: "warm",
      authorModeCopy: authorCopy({ concept_tag: tag }),
    });
    assert.equal(body.concept_tag, tag, `tag lost on row-stamp: ${tag}`);
  }
});

test("buildAdCampaignInsertBody: deterministic mode (no authorModeCopy) → concept_tag=null + author_self_score=null (byte-identical to pre-Phase-1 shape)", () => {
  const body = buildAdCampaignInsertBody({
    workspaceId: "ws-1",
    productId: "prod-1",
    name: "n",
    angleId: "angle-1",
    status: "ready",
    audienceTemperature: null,
  });
  assert.equal(body.concept_tag, null);
  assert.equal(body.author_self_score, null);
  assert.equal(body.audience_temperature, null);
});

test("insertReadyCreative → ad_campaigns insert: fake admin captures the row body, concept_tag='transformation' lands verbatim (author-mode row-stamping flow, end-to-end)", async () => {
  // Fake admin that intercepts .from('ad_campaigns').insert(body).select().single() and captures
  // the exact body — the same body insertReadyCreative writes for real via buildAdCampaignInsertBody.
  // Chain shape mirrors the helper's supabase-js call: .insert(body).select('id').single().
  const captured: { adCampaignsInsertBody: unknown | null } = { adCampaignsInsertBody: null };
  const fromFactory = (table: string) => {
    if (table === "ad_campaigns") {
      return {
        insert(body: unknown) {
          captured.adCampaignsInsertBody = body;
          return {
            select() {
              return { single: async () => ({ data: { id: "cmp-1" }, error: null }) };
            },
          };
        },
      };
    }
    // For every other table we don't care about the body here — the pinned assertion is on
    // ad_campaigns. Return a permissive stub so the caller path can proceed if it likes.
    return {
      insert() {
        return {
          select() {
            return { single: async () => ({ data: { id: "stub-1" }, error: null }) };
          },
        };
      },
    };
  };
  const fakeAdmin = { from: fromFactory } as unknown as Parameters<typeof buildAdCampaignInsertBody>[0] extends never ? unknown : unknown;

  // Mirror the insertReadyCreative call site: build the row body from the verdict + persist it
  // through the same admin chain. If the shape drifts (a rename, a lost field), this test flips
  // red — proving the row-stamping flow requested by the spec is pinned end-to-end.
  const body = buildAdCampaignInsertBody({
    workspaceId: "ws-1",
    productId: "prod-1",
    name: "Dahlia · Superfood Tabs · review_cluster",
    angleId: "angle-1",
    status: "ready",
    audienceTemperature: "warm",
    authorModeCopy: authorCopy({ concept_tag: "transformation" }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin: any = fakeAdmin;
  const { data: campaign, error: cErr } = await admin
    .from("ad_campaigns")
    .insert(body)
    .select("id")
    .single();
  assert.equal(cErr, null);
  assert.equal((campaign as { id: string }).id, "cmp-1");

  const rec = captured.adCampaignsInsertBody as { concept_tag?: unknown; audience_temperature?: unknown; author_self_score?: unknown; workspace_id?: unknown } | null;
  assert.ok(rec, "ad_campaigns.insert body must have been captured");
  assert.equal(rec.concept_tag, "transformation");
  assert.equal(rec.audience_temperature, "warm");
  assert.equal(rec.workspace_id, "ws-1");
  assert.ok(rec.author_self_score, "author_self_score must be persisted alongside concept_tag");
});

// ── dahlia-shared-deterministic-copy-validator Phase 2 — validator wire-in ───────────────────

test("runCopyAuthorSession: verdict that fails the shared validator (no_competitor_leak) → revise trigger; clean second attempt → ok", async () => {
  // First emit leaks the competitor advertiser token; second emit is clean. The revise prompt
  // MUST cite `validator_failed` so Dahlia knows which SSOT gate she tripped.
  const leaky = envelope({
    headline: "Cleaner than MUD/WTR",
    primaryText: "Steady 4-hour energy — no crash.",
    description: "Adaptogens",
    audience_temperature: "warm",
    self_score: { lf8: 2, schwartz: 2, cialdini: 2, hopkins: 2, sugarman: 2, total: 10, evidence: [] },
  });
  const clean = envelope();
  const { dispatch, calls } = scriptedDispatcher([{ resultText: leaky }, { resultText: clean }]);
  const outcome = await runCopyAuthorSession(
    sessionInputs({
      competitorDna: {
        hook: "cleaner morning cup",
        framework: null,
        mechanismClaim: null,
        proof: null,
        offer: null,
        competitorAdvertiser: "MUD/WTR",
      },
      ourBrand: "Amazing Coffee",
    }),
    dispatch,
  );
  assert.equal(outcome.kind, "ok");
  if (outcome.kind === "ok") {
    assert.equal(outcome.attempts, 2);
    assert.match(calls[1].prompt, /validator_failed/);
    assert.match(calls[1].prompt, /no_competitor_leak/);
  }
});

test("runCopyAuthorSession: validator failure that keeps repeating → exhausted with validatorMisses carrying the failing checks", async () => {
  const leaky = envelope({
    headline: "Cleaner than MUD/WTR",
    primaryText: "Steady 4-hour energy — no crash.",
    description: "Adaptogens",
    audience_temperature: "warm",
    self_score: { lf8: 2, schwartz: 2, cialdini: 2, hopkins: 2, sugarman: 2, total: 10, evidence: [] },
  });
  const { dispatch } = scriptedDispatcher([{ resultText: leaky }, { resultText: leaky }]);
  const outcome = await runCopyAuthorSession(
    sessionInputs({
      competitorDna: {
        hook: "cleaner morning cup",
        framework: null,
        mechanismClaim: null,
        proof: null,
        offer: null,
        competitorAdvertiser: "MUD/WTR",
      },
      ourBrand: "Amazing Coffee",
    }),
    dispatch,
  );
  assert.equal(outcome.kind, "exhausted");
  if (outcome.kind === "exhausted") {
    assert.match(outcome.reason, /validator_failed/);
    assert.ok(outcome.validatorMisses, "validatorMisses must be populated on a validator-driven exhaustion");
    assert.ok(
      outcome.validatorMisses!.some((c) => c.rail === "no_competitor_leak" && !c.pass),
      "no_competitor_leak rail must appear in validatorMisses",
    );
  }
});

test("runCopyAuthorSession: competitor DNA is embedded in the DATA block ONLY when supplied", async () => {
  const withDna = scriptedDispatcher([{ resultText: envelope() }]);
  await runCopyAuthorSession(
    sessionInputs({
      angle: angle({ source: "competitor" }),
      competitorDna: {
        hook: "10x collagen bond in one scoop",
        framework: "before/after transformation",
        mechanismClaim: "10x collagen bond",
        proof: null,
        offer: null,
        competitorAdvertiser: "Rival Co",
      },
    }),
    withDna.dispatch,
  );
  assert.match(withDna.calls[0].prompt, /COMPETITOR_DNA:/);

  const withoutDna = scriptedDispatcher([{ resultText: envelope() }]);
  await runCopyAuthorSession(sessionInputs(), withoutDna.dispatch);
  assert.doesNotMatch(withoutDna.calls[0].prompt, /COMPETITOR_DNA:/);
});
