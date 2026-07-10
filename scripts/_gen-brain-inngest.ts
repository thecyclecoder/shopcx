/**
 * Generates docs/brain/inngest/{file}.md for every src/lib/inngest/*.ts.
 *   npx tsx scripts/_gen-brain-inngest.ts
 *
 * Each page covers: triggers (event / cron), inngest functions defined,
 * downstream events sent, public.* tables read/written, and a curated
 * description sourced from the file's header comment + the SUMMARIES
 * map below.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "fs";
import { resolve, basename } from "path";

const inngestDir = resolve(__dirname, "../src/lib/inngest");
const outDir = resolve(__dirname, "../docs/brain/inngest");
mkdirSync(outDir, { recursive: true });

const allTables = new Set<string>(
  readdirSync(resolve(__dirname, "../docs/brain/tables")).map((f) => f.replace(/\.md$/, "")),
);

// ──────────────────────────────────────────────────────────────────────
// Hand-curated descriptions per file. Keep terse — what & why.
// ──────────────────────────────────────────────────────────────────────
const SUMMARIES: Record<string, string> = {
  "abandoned-cart.ts": "Sweeps `cart_drafts` past `expires_at` → flips to `abandoned`. Hourly.",
  "ai-nightly-analysis.ts": "Nightly review of recent AI-handled tickets. Writes `daily_analysis_reports`. Paused 2026-04-28.",
  "amazon-sync.ts": "Pulls Amazon SP-API order + ASIN data; writes `amazon_*`, `daily_amazon_order_snapshots`.",
  "amplifier-webhooks.ts": "Receives Amplifier (3PL) `order_received` / `order_shipped` webhooks → updates `orders.amplifier_*` fields.",
  "auto-archive.ts": "Archives closed tickets older than threshold (sets `archived_at`).",
  "chargeback-processing.ts": "Shopify dispute pipeline: classify → auto-cancel sub OR review → won/lost. Writes `chargeback_events`, `chargeback_subscription_actions`.",
  "client.ts": "Inngest SDK client init. Not a function — just exports `inngest`.",
  "crisis-campaign.ts": "Daily crisis-campaign cron. Finds eligible subs per active `crisis_events`, advances tiers, auto-swaps default flavor. Writes `crisis_customer_actions`. See CRISIS-MANAGEMENT-SPEC.md.",
  "customer-demographics.ts": "Enriches `customer_demographics` from Census + Versium for new customers.",
  "daily-analysis-report-cron.ts": "Cron wrapper that schedules `ai-nightly-analysis`.",
  "daily-order-snapshot.ts": "Daily rollup → `daily_order_snapshots`. Drives the home dashboard charts.",
  "deliver-pending-send.ts": "Cron: scans `ticket_messages.pending_send_at <= now()` and actually sends the message via Resend/Twilio/Meta. The reason outbound messages appear in the UI immediately but ship after a delay.",
  "delivery-audit.ts": "Audits EasyPost-tracked orders that are stuck (in_transit too long) — surfaces in `dashboard_notifications`.",
  "dunning.ts": "Dunning orchestrator: payment-failed → card rotation → payday retries → cycle action. Plus new-card-recovery + billing-success cleanup. Writes `dunning_cycles`, `payment_failures`. See Phase 5 in CLAUDE.md.",
  "fraud-detection.ts": "Per-order + per-customer + nightly fraud scans. Evaluates `fraud_rules`, writes `fraud_cases`, tags Shopify orders `suspicious` for hold.",
  "import-subscriptions.ts": "One-off bulk pull from Appstle for the initial subscription import / re-sync.",
  "internal-subscription-renewals.ts": "Renews `subscriptions.is_internal=true` rows on schedule (post-Appstle scheduler stub).",
  "journey-outcomes.ts": "Records journey outcomes onto tickets — fires `jo:positive` / `jo:negative` / `jo:neutral` tags.",
  "kb-embed.ts": "Embeds new/updated `knowledge_base` articles into `kb_chunks` via OpenAI embeddings.",
  "klaviyo-attribution-compute.ts": "Recomputes `klaviyo_sms_campaign_history.initial_revenue_cents` by joining Placed Orders via `attributed_klaviyo_campaign_id`.",
  "klaviyo-engagement-backfill.ts": "180d historical engagement events backfill. **Unreliable on Vercel** — prefer `scripts/backfill-engagement-local.ts`.",
  "klaviyo-engagement-sync.ts": "Daily 4am CST incremental engagement delta. Hard 1-day lookback, hardcoded metric_ids. Writes `profile_events`.",
  "klaviyo-events-import.ts": "Pulls Klaviyo Placed Order events with UTM-attribution parsing. Writes `klaviyo_events`.",
  "klaviyo-sms-import.ts": "On-demand pull of historical Klaviyo SMS campaigns → `klaviyo_sms_campaign_history`.",
  "macro-audit.ts": "Periodic audit of macro acceptance rates. Flags low-performing macros for admin review.",
  "marketing-coupon-cron.ts": "Auto-disables expired SMS-campaign coupons in Shopify `coupon_expires_days_after_send` days after first send.",
  "marketing-text.ts": "SMS campaign send pipeline. textCampaignScheduled (create recipients + reserve shortlink + generate coupon) + textCampaignSendTick (5-min cron, sends pending recipients via Twilio).",
  "meta-historical-comments-sync.ts": "Backfills `social_comments` from Meta Graph for historical posts/ads (per-page sync).",
  "meta-sync.ts": "Per-workspace Meta Page + Instagram sync — refreshes `meta_pages` and ad metadata.",
  "monthly-revenue-snapshot.ts": "Month-end rollup → `monthly_revenue_snapshots`.",
  "order-address-fallback.ts": "Async job: when an order arrives with null ship+bill addresses, pulls `Customer.defaultAddress` from Shopify and backfills. See feedback_address_mirror_rule.",
  "portal-auto-resume.ts": "Resumes paused subs at `pause_resume_at`. Used by cancel-flow pause remedies + crisis Tier 3.",
  "product-intelligence.ts": "Generates the structured product-intelligence surface — product_ingredient_research (mechanism + clinical citations) + product_review_analysis (claim clusters). Read via src/lib/product-intelligence.ts.",
  "refresh-customer-segments.ts": "Recomputes `customers.segments` array for archetype-driven SMS targeting. See PERPETUAL-CAMPAIGNS-SPEC.md.",
  "reseller-discovery.ts": "Weekly Mon 6am CT cron: pulls competitor offers per ASIN from Amazon SP-API → scrapes seller storefronts → upserts `known_resellers`.",
  "returns.ts": "Returns refund pipeline: returns/process-delivery (EasyPost delivered → fire issue-refund) and returns/issue-refund (partial refund OR store credit, close return, email customer).",
  "review-tagging.ts": "Tags `product_reviews` with `featured` / topic clusters via Haiku.",
  "scrape-help-center.ts": "Crawler that imports an existing help-center site into `knowledge_base`. Used for the Gorgias → ShopCX migration.",
  "seo-keyword-research.ts": "Generates `product_seo_keywords` via Google Search Console + AI keyword extraction.",
  "sms-wave-promote.ts": "Promotes the next wave of `sms_send_candidates` into `sms_campaign_recipients` based on archetype + replenishment ratio.",
  "social-comment-moderate.ts": "Per-comment moderation pipeline — runs the orchestrator, posts replies, hides/deletes if needed. Writes `social_comments`, `social_comment_replies`.",
  "sync-inventory.ts": "Shopify inventory sync. Writes `product_variants.inventory_quantity`.",
  "sync-reviews.ts": "Nightly + on-demand Klaviyo review sync → `product_reviews` with AI summaries (Haiku, max 15 words).",
  "sync-shopify.ts": "Main Shopify bulk sync — customers, orders, products via GraphQL Bulk Operations. Drives `import_jobs` progress.",
  "ticket-analysis-cron.ts": "Nightly cron that runs `ticket-analyzer.ts` over recent tickets → `ticket_analyses`.",
  "ticket-csat.ts": "Sends CSAT survey 24h after a ticket closes. Writes `tickets.csat_score` on response.",
  "ticket-research.ts": "Research-and-heal pipeline: deep investigation → recipe match → propose heal → auto-execute allowlisted. Writes `ticket_research_runs`, `ticket_heal_attempts`. See RESEARCH-AND-HEAL.md.",
  "ticket-snooze.ts": "Wakes snoozed tickets at `snoozed_until`.",
  "today-sync.ts": "Today-only incremental Shopify sync (faster path than the full bulk op).",
  "unified-ticket-handler.ts": "**THE main pipeline.** Every inbound message: resolve → playbook check → Sonnet orchestrator → execute decision. Touches almost every table. See UNIFIED-HANDLER.md.",
};

// ──────────────────────────────────────────────────────────────────────
// Parse helpers
// ──────────────────────────────────────────────────────────────────────
function parseHeaderComment(src: string): string {
  const lines = src.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (line.trim().startsWith("//")) {
      out.push(line.replace(/^\s*\/\/\s?/, ""));
    } else if (line.trim().startsWith("/*")) {
      continue;
    } else if (out.length > 0) {
      break;
    } else if (line.trim() === "") {
      continue;
    } else {
      break;
    }
  }
  return out.join("\n").trim();
}

function extractFunctions(src: string): { id: string; trigger: string; concurrency?: string; retries?: string }[] {
  const fns: { id: string; trigger: string; concurrency?: string; retries?: string }[] = [];
  const regex = /createFunction\s*\(\s*\{([\s\S]*?)\}\s*,\s*async/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(src)) !== null) {
    const body = m[1];
    const idM = body.match(/id\s*:\s*"([^"]+)"/);
    const eventM = body.match(/event\s*:\s*"([^"]+)"/);
    const cronM = body.match(/cron\s*:\s*"([^"]+)"/);
    const retriesM = body.match(/retries\s*:\s*(\d+)/);
    const concM = body.match(/concurrency\s*:\s*\[?\s*\{[\s\S]*?\}\s*\]?/);
    fns.push({
      id: idM?.[1] || "(unnamed)",
      trigger: eventM ? `event \`${eventM[1]}\`` : cronM ? `cron \`${cronM[1]}\`` : "_unknown_",
      retries: retriesM?.[1],
      concurrency: concM?.[0],
    });
  }
  return fns;
}

function extractSentEvents(src: string): Set<string> {
  const events = new Set<string>();
  // inngest.send({ name: "..." }) or step.sendEvent("...", { name: "..." })
  const nameRegex = /name\s*:\s*"([^"]+\/[^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = nameRegex.exec(src)) !== null) events.add(m[1]);
  // also: inngest.send({ name, ... } where name was set above) — captured by name: pattern
  return events;
}

function extractTableWrites(src: string): { reads: Set<string>; writes: Set<string> } {
  const reads = new Set<string>();
  const writes = new Set<string>();
  const fromRegex = /\.from\(\s*["']([a-z_][a-z0-9_]*)["']\s*\)\s*\.([a-zA-Z_]+)/g;
  let m: RegExpExecArray | null;
  while ((m = fromRegex.exec(src)) !== null) {
    const table = m[1];
    const op = m[2];
    if (["insert", "update", "upsert", "delete"].includes(op)) writes.add(table);
    else reads.add(table);
  }
  return { reads, writes };
}

function linkTable(t: string): string {
  return allTables.has(t) ? `[[../tables/${t}]]` : `\`${t}\``;
}

function renderPage(file: string, src: string): string {
  const name = file.replace(/\.ts$/, "");
  const summary = SUMMARIES[file] || parseHeaderComment(src).split("\n")[0] || "_TODO_";
  const header = parseHeaderComment(src);
  const fns = extractFunctions(src);
  const sent = [...extractSentEvents(src)];
  const { reads, writes } = extractTableWrites(src);

  // Don't double-list trigger events as "sent" events
  const triggerEvents = new Set(fns.map((f) => f.trigger.match(/`([^`]+)`/)?.[1]).filter(Boolean) as string[]);
  const downstream = sent.filter((e) => !triggerEvents.has(e));

  const fnsBlock = fns.length
    ? fns
        .map((f) =>
          `### \`${f.id}\`
- **Trigger:** ${f.trigger}
${f.retries ? `- **Retries:** ${f.retries}\n` : ""}${f.concurrency ? `- **Concurrency:** \`${f.concurrency.replace(/\s+/g, " ").trim()}\`\n` : ""}`,
        )
        .join("\n\n")
    : "_No Inngest functions defined in this file (helper module)._";

  const downstreamBlock = downstream.length
    ? downstream.map((e) => `- \`${e}\``).sort().join("\n")
    : "_None._";

  const writesBlock = writes.size
    ? [...writes].sort().map(linkTable).map((s) => `- ${s}`).join("\n")
    : "_None._";

  const readsBlock = reads.size
    ? [...reads].sort().filter((t) => !writes.has(t)).map(linkTable).map((s) => `- ${s}`).join("\n")
    : "_None._";

  const headerBlock = header && header.length > summary.length + 10
    ? `\n## Header notes\n\n\`\`\`\n${header}\n\`\`\`\n`
    : "";

  return `# inngest/${name}

${summary}

**File:** \`src/lib/inngest/${file}\`

## Functions

${fnsBlock}

## Downstream events sent

${downstreamBlock}

## Tables written

${writesBlock}

## Tables read (not written)

${readsBlock}
${headerBlock}
---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
`;
}

const files = readdirSync(inngestDir).filter((f) => f.endsWith(".ts")).sort();
let wrote = 0;
for (const file of files) {
  const src = readFileSync(resolve(inngestDir, file), "utf8");
  writeFileSync(resolve(outDir, `${file.replace(/\.ts$/, "")}.md`), renderPage(file, src));
  wrote++;
}
console.log(`Wrote ${wrote} inngest pages to docs/brain/inngest/`);
