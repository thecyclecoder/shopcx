/**
 * Generates docs/brain/libraries/{file}.md for every src/lib/*.ts file
 * (and key subdirs). Each page lists exports + signatures + callers + gotchas.
 *
 *   npx tsx scripts/_gen-brain-libraries.ts
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, statSync } from "fs";
import { resolve, relative, basename, dirname } from "path";

const projectRoot = resolve(__dirname, "..");
const libDir = resolve(projectRoot, "src/lib");
const outDir = resolve(projectRoot, "docs/brain/libraries");
mkdirSync(outDir, { recursive: true });

// ──────────────────────────────────────────────────────────────────────
// Discover files. Skip inngest/ (already has its own folder).
// ──────────────────────────────────────────────────────────────────────
function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "inngest") continue;
      walk(full, files);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      files.push(full);
    }
  }
  return files;
}

const allLibFiles = walk(libDir).sort();
const libFileRelPaths = allLibFiles.map((p) => relative(projectRoot, p));

// ──────────────────────────────────────────────────────────────────────
// Build a global caller index. For each lib file, find all files that
// import it via "@/lib/{name}" or relative path within lib.
// ──────────────────────────────────────────────────────────────────────
const callerIndex = new Map<string, Set<string>>();

function walkAll(dir: string, files: string[] = [], skip: string[] = ["node_modules", ".next", ".git", "docs", "scripts"]): string[] {
  for (const entry of readdirSync(dir)) {
    if (skip.includes(entry)) continue;
    const full = resolve(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkAll(full, files, skip);
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      files.push(full);
    }
  }
  return files;
}

const srcFiles = walkAll(resolve(projectRoot, "src"));
console.log(`Scanning ${srcFiles.length} src files for imports…`);

for (const srcFile of srcFiles) {
  const content = readFileSync(srcFile, "utf8");
  const rel = relative(projectRoot, srcFile);
  // Match `from "@/lib/foo"` or `from "@/lib/foo/bar"`
  const matches = content.matchAll(/from\s+["']@\/lib\/([a-zA-Z0-9_\-\/]+)["']/g);
  for (const m of matches) {
    const targetName = m[1];
    if (!callerIndex.has(targetName)) callerIndex.set(targetName, new Set());
    callerIndex.get(targetName)!.add(rel);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Parse a single file for exports + header comment.
// ──────────────────────────────────────────────────────────────────────
type ExportItem = { kind: string; name: string; signature: string; jsdoc?: string };

function parseFile(abs: string): { header: string; exports: ExportItem[]; importPath: string } {
  const src = readFileSync(abs, "utf8");
  const rel = relative(libDir, abs).replace(/\.ts$/, "");
  const importPath = rel; // e.g. "appstle" or "portal/handlers/cancel"

  // Header: leading comment block (// or /* */)
  let header = "";
  const lines = src.split("\n");
  let i = 0;
  // Skip directives
  while (i < lines.length && /^["']use\s+(client|server|strict)["'];?$/.test(lines[i].trim())) i++;
  if (lines[i]?.trim().startsWith("/*")) {
    const buf: string[] = [];
    while (i < lines.length) {
      const ln = lines[i].trim();
      if (ln.startsWith("/**") || ln.startsWith("/*")) { buf.push(ln.replace(/^\/\*+/, "").trim()); i++; }
      else if (ln.endsWith("*/")) { buf.push(ln.replace(/\*+\/$/, "").replace(/^\*\s?/, "").trim()); i++; break; }
      else { buf.push(ln.replace(/^\*\s?/, "").trim()); i++; }
    }
    header = buf.filter(Boolean).join("\n");
  } else {
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim().startsWith("//")) {
      buf.push(lines[i].replace(/^\s*\/\/\s?/, ""));
      i++;
    }
    header = buf.join("\n").trim();
  }

  // Exports: regex-based
  const exports: ExportItem[] = [];
  const exportRegexes: { kind: string; re: RegExp }[] = [
    { kind: "function", re: /^export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*([\s\S]*?)\)\s*(?::\s*[^{]+)?\s*\{/gm },
    { kind: "const", re: /^export\s+(?:async\s+)?const\s+([A-Za-z0-9_]+)\s*(?::\s*[^=]+)?=\s*([^;]+?)(?:;|\n)/gm },
    { kind: "class", re: /^export\s+(?:abstract\s+)?class\s+([A-Za-z0-9_]+)/gm },
    { kind: "interface", re: /^export\s+interface\s+([A-Za-z0-9_]+)/gm },
    { kind: "type", re: /^export\s+type\s+([A-Za-z0-9_]+)/gm },
    { kind: "enum", re: /^export\s+enum\s+([A-Za-z0-9_]+)/gm },
  ];

  // Functions: extract full signature up to the first `{`
  const fnRegex = /^export\s+(async\s+)?function\s+([A-Za-z0-9_]+)\s*(\([\s\S]*?\))\s*(:\s*[^{]+?)?\s*\{/gm;
  let m: RegExpExecArray | null;
  while ((m = fnRegex.exec(src)) !== null) {
    const isAsync = !!m[1];
    const name = m[2];
    const params = m[3].replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");
    const ret = m[4] ? m[4].trim() : "";
    exports.push({
      kind: "function",
      name,
      signature: `${isAsync ? "async " : ""}function ${name}${params}${ret ? " " + ret : ""}`,
    });
  }

  // export const NAME = ... — keep just the name + type if known
  const constRegex = /^export\s+(async\s+)?const\s+([A-Za-z0-9_]+)\s*(:\s*[^=]+?)?=/gm;
  while ((m = constRegex.exec(src)) !== null) {
    const name = m[2];
    const typeAnnot = m[3] ? m[3].trim() : "";
    exports.push({ kind: "const", name, signature: `const ${name}${typeAnnot}` });
  }

  for (const { kind, re } of exportRegexes.slice(2)) {
    const r2 = new RegExp(re.source, "gm");
    while ((m = r2.exec(src)) !== null) {
      const name = m[1];
      exports.push({ kind, name, signature: `${kind} ${name}` });
    }
  }

  // Re-exports: export { x } from "..."
  const reExportRegex = /^export\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/gm;
  while ((m = reExportRegex.exec(src)) !== null) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/i).pop()?.trim();
      if (name) exports.push({ kind: "re-export", name, signature: `re-export from \`${m[2]}\`` });
    }
  }

  // De-dup by name
  const seen = new Set<string>();
  const dedup: ExportItem[] = [];
  for (const e of exports) {
    if (seen.has(e.name)) continue;
    seen.add(e.name);
    dedup.push(e);
  }

  return { header, exports: dedup, importPath };
}

// ──────────────────────────────────────────────────────────────────────
// Curated summaries + gotchas keyed by import path (e.g. "appstle", "portal/handlers/cancel").
// Long-tail files get auto-summary from header comment.
// ──────────────────────────────────────────────────────────────────────
const SUMMARIES: Record<string, string> = {
  "sonnet-orchestrator-v2": "The brain. Tool-use orchestrator that picks an action_type per inbound message. Loads on-demand data via tool calls (get_customer_account, get_returns, get_crisis_status, etc.). Returns a `SonnetDecision` JSON the action executor dispatches.",
  "action-executor": "Dispatches `SonnetDecision` JSON. Handles direct_action / journey / playbook / workflow / macro / kb_response / ai_response / escalate. Resolves handler_name against journeys, playbooks, workflows by name OR trigger_intent (case-insensitive). Single source of truth for executing AI decisions.",
  "subscription-items": "Appstle line-item mutations: swap, add, remove, price update, quantity update. Wraps Appstle's subscription-contract-* endpoints. **Has 0.75 SubSave price multiplier baked into `subUpdateLineItemPrice`** — set the visible price; the multiplier shifts it to the post-SubSave price on the contract.",
  "subscription-add-items": "Add line items to an existing subscription via Appstle. Used by crisis Tier 2 re-add and replacement-order playbook step 7.",
  "appstle": "Appstle Subscriptions API client. Per-workspace API key + shop domain. Every helper checks `isInternalSubscription()` first and routes to `internal-subscription.ts` for internal subs. See [[../integrations/appstle]].",
  "appstle-discount": "`applyDiscountWithReplace()` — removes any existing coupon, then applies a new one atomically. One coupon per sub — never stack. Driven by [[../tables/coupon_mappings]] for VIP-tier resolution.",
  "appstle-call-log": "`loggedAppstleFetch()` — wraps every Appstle HTTP call into [[../tables/appstle_api_calls]] for replay + debugging.",
  "internal-subscription": "Internal-subscription path (`is_internal=true`). Mutations are pure DB updates; no Appstle calls. Future home of the in-house billing-tick scheduler. See [[../lifecycles/subscription-billing]].",
  "replacement-order": "`createReplacementOrder()` — builds + completes a Shopify draft order at no charge to the customer. Stamps with `replacement: true` so downstream events skip marketing attribution + LTV bump. Tracks against `workspaces.replacement_threshold_cents`.",
  "shopify-returns": "`createFullReturn()` (the single entry point for new returns), `closeReturn()`, `partialRefundByAmount()`, `issueStoreCredit()`. Stores `net_refund_cents` at creation; pipeline trusts it forever. See [[../lifecycles/return-pipeline]].",
  "shopify-order-actions": "Shopify order mutations: refunds, cancellations, address updates. Bridges to [[../integrations/braintree]] for Braintree-paid orders.",
  "shopify-order-tags": "`addOrderTags()` / `removeOrderTags()` via Shopify GraphQL `tagsAdd` / `tagsRemove`. Used by fraud detection to apply `suspicious` tag for fulfillment hold.",
  "shopify-marketing": "Email + SMS marketing consent mutations: `customerEmailMarketingConsentUpdate`, `customerSmsMarketingConsentUpdate`. Used by discount-signup journey + chargeback auto-unsubscribe.",
  "shopify-customer-update": "`customerUpdate` mutation for default address + email + phone updates.",
  "shopify-draft-orders": "Draft order create + complete. Used by replacement-order playbook + storefront cart-bridge legacy path.",
  "shopify-sync": "Bulk operations + GraphQL helper + paginated sync. `fetchWithRetry` retries 429 + 5xx. `cancelBulkOperation()` clears stuck ops. Drives [[../inngest/sync-shopify]] + [[../inngest/today-sync]].",
  "shopify-webhooks": "Customer + order webhook handlers. Address fallback chain, customers/merge auto-link, orders/create → fraud detection trigger.",
  "shopify-webhook-register": "Registers Shopify webhook subscriptions per workspace on connect.",
  "shopify": "OAuth URL builder, HMAC verifier, API version + scope constants. Shopify entry point. See [[../integrations/shopify]].",
  "dunning": "Core dunning logic: card dedup, payday scheduling, settings, cycle CRUD, error-code categorization. See [[../lifecycles/dunning]].",
  "dunning-webhook": "Shopify `billing_attempt_failure` + `customer_payment_methods/*` webhook handlers. Creates [[../tables/dunning_cycles]] rows + fires Inngest events.",
  "loyalty": "Loyalty program: tier eligibility, point earn, redemption, coupon generation. Drives [[../tables/loyalty_members]] + [[../tables/loyalty_transactions]].",
  "journey-launcher": "Unified launcher: `launchJourneyForTicket()`. Resolves journey by name + intent, creates [[../tables/journey_sessions]] row, delivers CTA via [[../lib/journey-delivery]].",
  "journey-step-builder": "Switch that delegates to per-journey builders (cancel, discount, crisis tiers, shipping-address, missing-items, select-subscription, account-linking).",
  "journey-delivery": "Channel-aware journey delivery: email CTA, chat inline form, SMS / Meta DM URL. Honors `chat_idle` switch to email after 3 min.",
  "journey-tokens": "Generate + verify journey session tokens for `/journey/{token}` URLs.",
  "journey-seed": "Default cancel-flow config + DEFAULT_REMEDIES seed for new workspaces.",
  "cancel-journey-builder": "THE cancel journey builder. Loads subs (across linked accounts), detects first-renewal + shipping protection, loads reasons from `workspaces.portal_config.cancel_flow.reasons`.",
  "cancel-lead-in": "Generates the lead-in message for cancel journey CTAs.",
  "remedy-selector": "Haiku remedy selection (`selectRemedies()`) + Sonnet open-ended chat (`openEndedCancelChat()`). Uses per-(reason, remedy) stats from [[../tables/remedy_outcomes]].",
  "crisis-journey-builder": "Per-tier crisis journey builders (Tier 1 flavor swap, Tier 2 product swap, Tier 3 pause/remove).",
  "missing-items-journey-builder": "Builds the missing-items checklist step from an order's line items.",
  "shipping-address-journey-builder": "Builds the address-change journey: select target (sub / order / default) → enter → validate via EasyPost.",
  "select-subscription-journey-builder": "Builds the subscription picker step. Used by cancel journey + playbooks when disambiguation needed.",
  "account-linking-journey-builder": "Builds the account-linking prepend step (checklist of candidate emails). Never standalone.",
  "marketing-signup-journey-builder": "Marketing-signup variant of discount journey for some contexts.",
  "social-comment-orchestrator": "Two-pass Sonnet pipeline: pass 1 Haiku classifier, pass 2 Sonnet reply generator. See [[../lifecycles/social-comment-moderation]].",
  "social-comment-actions": "`replyComment()`, `hideComment()`, `deleteComment()`, `sendDMReply()` via [[../integrations/meta-graph]].",
  "social-comment-ingest": "Webhook parser + persist for inbound comments + DMs.",
  "social-comment-customer-match": "Match comment author / DM sender → internal customer. Looks up [[../tables/meta_sender_customer_links]] first; falls back to email match.",
  "meta": "Meta Graph + OAuth client. Auth URL builder, token mint, permission check, low-level Graph API wrapper.",
  "meta-product-match": "Match comment text → product UUID via embeddings + Haiku. Returns canonical product URL.",
  "meta-test-helpers": "Mock helpers for Meta API in tests.",
  "klaviyo": "Klaviyo API client (reviews, profiles, events). See [[../integrations/klaviyo]].",
  "avalara": "Sales tax client. Quote (SalesOrder) + commit (SalesInvoice) + void. See [[../integrations/avalara]].",
  "avalara-cart": "Quote tax for [[../tables/cart_drafts]] at checkout.",
  "avalara-subscription": "Quote tax for [[../tables/subscriptions]] at billing tick.",
  "avalara-tax-codes": "Tax code lookup per [[../tables/product_variants]]. Falls back to `workspaces.avalara_default_tax_code`.",
  "email": "Resend send wrapper. Templates: ticket reply, CSAT, invite, journey CTA, dunning (payment-update / recovery / paused), return confirmation, password reset.",
  "email-cleaner": "Strip quoted history + HTML for `body_clean`. Used on every inbound email parse.",
  "email-tracking": "Self-hosted open pixel + click redirect tracking. Writes [[../tables/email_events]]. Pixel URL `/api/email/open?e={id}` + redirect `/api/email/click?e={id}&u={url}`.",
  "email-utils": "Threading helpers: `In-Reply-To` + `References` header builders.",
  "email-storefront": "Storefront transactional emails (order confirmation, shipping notifications).",
  "crypto": "AES-256-GCM `encrypt()` / `decrypt()`. Uses `ENCRYPTION_KEY` env (64-char hex). Every `*_encrypted` column on [[../tables/workspaces]] goes through this.",
  "rag": "Unified RAG retriever — KB chunks ([[../tables/kb_chunks]]) + macros ([[../tables/macros]]) via pgvector. Returns ranked + de-duped results.",
  "embeddings": "Provider-agnostic embedding wrapper. Currently OpenAI `text-embedding-3-small` (1536d). See [[../integrations/openai]].",
  "fraud-detector": "Rule evaluator + case creator. Iterates active [[../tables/fraud_rules]] for the workspace, runs the matcher per rule, creates [[../tables/fraud_cases]] on match.",
  "pattern-matcher": "3-layer classifier: keyword match → pgvector embedding → Claude Haiku fallback. Drives smart-tag application.",
  "rules-engine": "Synchronous compound AND/OR rules engine. 8 action types: tags, status, assign, auto-reply, internal note, customer update, Appstle pause/cancel.",
  "rules-actions": "Action handlers for rules-engine. One handler per action type.",
  "ticket-tags": "`addTicketTag()` — idempotent tag set. Used everywhere downstream effects need to be tagged.",
  "first-touch": "`markFirstTouch()` — applies `touched` + `ft:{source}` tag. Idempotent — only the first outbound touch matters.",
  "ai-context": "Pre-loaded context builder for the orchestrator. Customer + ticket history + handler catalog + personality + rule pack.",
  "ai-date-context": "Relative-date helpers (e.g. 'last Tuesday') for AI prompts.",
  "ai-models": "Model id constants + SDK client. Single source of truth — `claude-haiku-4-5-20251001`, `claude-sonnet-4-6`, `claude-opus-4-7`. Never hardcode model ids elsewhere.",
  "ai-usage": "Token accounting writes to [[../tables/ai_token_usage]]. `withTokenAccounting()` wraps SDK calls.",
  "model-picker": "Per-call model selection: turn 1-2 Haiku, turn 3+ Sonnet, deep analysis Opus.",
  "escalation": "Round-robin agent assignment. `assignToNextAvailable()`.",
  "customer-fraud-status": "`getCustomerFraudStatus()` — orchestrator short-circuit check. Returns `confirmed_fraud` or `amazon_reseller` flag across the customer's link group.",
  "customer-events": "`logCustomerEvent()` — writes [[../tables/customer_events]]. Source of truth for the activity timeline (sub cancel/pause timestamps live here, not on the sub row).",
  "customer-stats": "Helpers: `getCustomerSubscriptions()`, `getCustomerOrders()`, `getCustomerLTV()`. Expand linked accounts via `linkedIds()`.",
  "customer-timeline": "Build a chronological customer event timeline for AI prompts + agent UI.",
  "customer-demographics": "Census + Versium demographic enrichment. Writes [[../tables/customer_demographics]].",
  "account-matching": "Fuzzy name + address match heuristics for proposing account links.",
  "auto-link-customer-from-message": "Extract order numbers / emails / phones from inbound messages → propose customer link.",
  "address-normalize": "Lowercase + strip punctuation + expand street suffixes. Used by fraud detection address comparison + EasyPost shipment building.",
  "geo-distance": "Haversine distance + US zip centroid lookup via `zipcodes` package. Powers `address_distance` fraud rule.",
  "known-resellers": "Reseller match logic: two-pass exact + Haiku fuzzy. See [[../lifecycles/fraud-detection]] § amazon_reseller.",
  "playbook-executor": "Step engine for [[../playbooks]]. Routes inbound messages through playbook steps when `active_playbook_id` is set on the ticket.",
  "workflow-executor": "Template-based deterministic workflow executor: order_tracking, account_login, end_chat. Distinct from [[playbook-executor]].",
  "improve-actions": "Improve-tab actions for agent overrides on playbook tickets.",
  "improve-tools": "Tools the improve tab exposes (apply exception, force stand firm, jump to step, etc.).",
  "ticket-analyzer": "Per-ticket AI analysis: sentiment, intent, summary, suggested action. Writes [[../tables/ticket_analyses]].",
  "ticket-merge": "Merge duplicate tickets via `merged_into` self-FK. Combines messages, retains the canonical id.",
  "twilio": "SMS send + webhook signature verifier. See [[../integrations/twilio]].",
  "twilio-verify": "Verify v2 OTP flow for customer phone verification.",
  "marketing-text-timezone": "Resolution chain: customer tz → shipping zip → area code → workspace fallback. Drives per-recipient SMS send time.",
  "marketing-coupons": "Coupon code resolution by VIP tier from [[../tables/coupon_mappings]]. Used by discount-signup journey.",
  "easypost": "SDK wrapper, address validation, rate selection (USPS-pinned). See [[../integrations/easypost]].",
  "easypost-email": "Return label email send via Resend.",
  "easypost-order-sync": "Per-order shipment + tracker creation. Used by replacement-order playbook tracking check.",
  "billing-forecast": "Event writes to [[../tables/billing_forecast_events]]. Materialized rollup into [[../tables/billing_forecasts]].",
  "retention-score": "Computes retention score 0-100: recency 30%, frequency 25%, LTV 25%, subscription 20%.",
  "store-credit": "Store credit issuance via Shopify `storeCreditAccountCredit`. Writes [[../tables/store_credit_log]].",
  "loyalty": "Loyalty program: tier eligibility, point earn / spend, redemption tier resolution, coupon code generation.",
  "magic-link": "Magic-link auth for passwordless dashboard login.",
  "multipass": "Shopify Multipass SSO token generation for customer portal links.",
  "order-number": "Internal order number generator (e.g. `SC129467`). Uses workspace prefix + monotonic counter.",
  "shipping-rates": "Storefront shipping rate resolution per (region, weight).",
  "shortlink-slug": "Customer short_code generator (Crockford base32, 6 chars).",
  "image-transcode": "Image resizing + transcoding for product media.",
  "identity-stitch": "Anonymous-id + device-fingerprint backfill. See [[../lifecycles/storefront-checkout]] § Identity bootstrap.",
  "storefront-pixel": "Browser pixel client lib (track, identify, batching, sendBeacon on unload).",
  "delivery-channel": "Per-ticket-channel personality + delay config resolution.",
  "cart-gifts": "Free-gift logic for storefront cart.",
  "packing-slip-message": "Packing-slip insert message generator for orders.",
  "translate": "Multi-language detection + translation hooks.",
  "kb-chunker": "Splits KB articles into chunks for embedding.",
  "widget-cors": "CORS helpers for the chat widget endpoint.",
  "access": "Per-route role gating helpers (`requireRole()`).",
  "auth-session": "Server-side auth session helpers (workspace resolution, user fetch).",
  "workspace": "Workspace helpers: `getWorkspace()`, `getWorkspaceById()`, `getCurrentWorkspace()`.",
  "product-variants": "First-class variant helpers: `getProductVariants()`, `findVariant()`, `getVariantIndex()`. Internal UUID-keyed; never use Shopify variant id for joins.",
  "daily-analysis-report": "Generates daily AI analysis reports.",
  "google-ads": "Google Ads API client (read campaigns + spend).",
  "google-search-console": "Google Search Console API client.",
  "census": "US Census API client for demographics.",
  "versium": "Versium API client for demographics.",
  "slack": "Slack OAuth + API client for workspace integrations.",
  "slack-notify": "`dispatchSlackNotification()` — routes per-event Slack messages per [[../tables/slack_notification_rules]].",
  "portal/auth": "Shopify App Proxy HMAC-SHA256 verification + workspace resolution. Used by [[../integrations/shopify]] App Proxy on every portal call.",
  "portal/helpers": "Portal response helpers, event logging, Appstle error wrapping.",
  "portal/types": "TypeScript types shared across portal handlers.",
  "portal/handlers/bootstrap": "Portal bootstrap — loads customer + workspace branding + journey enablement.",
  "portal/handlers/home": "Portal home — sub list + recent orders summary.",
  "portal/handlers/subscriptions": "Portal subscriptions list endpoint.",
  "portal/handlers/subscription-detail": "Portal sub detail — items, recovery status, activity log.",
  "portal/handlers/pause": "Portal pause sub.",
  "portal/handlers/resume": "Portal resume sub.",
  "portal/handlers/cancel": "Portal cancel — launches [[../journeys/cancel]] journey.",
  "portal/handlers/cancel-journey": "Portal-side cancel journey step handler.",
  "portal/handlers/reactivate": "Portal reactivate cancelled sub.",
  "portal/handlers/address": "Portal address change.",
  "portal/handlers/replace-variants": "Portal swap variant on a sub line.",
  "portal/handlers/coupon": "Portal apply / remove coupon.",
  "portal/handlers/frequency": "Portal frequency change.",
  "portal/handlers/change-date": "Portal next billing date change.",
  "portal/handlers/order-now": "Portal bill now (manual renewal).",
  "portal/handlers/remove-line-item": "Portal remove a line item from sub.",
  "portal/handlers/payment-methods": "Portal list payment methods.",
  "portal/handlers/dunning-status": "Portal dunning status display.",
  "portal/handlers/reviews": "Portal reviews list for sub products.",
  "portal/handlers/account": "Portal account info display + edit.",
  "portal/handlers/support": "Portal support ticket entry point.",
  "portal/handlers/link-accounts": "Portal account linking handler.",
  "portal/handlers/loyalty-balance": "Portal loyalty balance + tier info.",
  "portal/handlers/loyalty-redeem": "Portal loyalty redemption.",
  "portal/handlers/loyalty-apply-subscription": "Portal apply loyalty coupon to sub.",
  "portal/handlers/ban-request": "Portal customer ban request (rare — flagged for review).",
  "portal/handlers/index": "Portal handler dispatch table.",
  "portal/helpers/cadence": "Portal cadence (frequency) display helpers.",
  "portal/helpers/image-fallback": "Portal product image fallback URL.",
  "portal/helpers/transform-subscription": "Portal sub transform: DB row → portal-facing JSON.",
  "integrations/braintree": "Braintree gateway client. `getBraintreeGateway()`, `refundBraintreeTransaction()`. See [[../integrations/braintree]].",
  "integrations/braintree-customer": "Braintree customer create / find helpers.",
  "integrations/amplifier": "Amplifier (3PL) webhook handler — `order_received` / `order_shipped` events.",
  "supabase/admin": "Service-role Supabase client (`createAdminClient()`). All server-side writes use this.",
  "supabase/client": "Anon Supabase client for browser-side use (RLS-respecting).",
  "supabase/server": "SSR Supabase client for server components.",
  "supabase/middleware": "Auth + workspace + sandbox + subdomain routing middleware.",
  "supabase/database.types": "Auto-generated DB types from Supabase CLI.",
  "amazon/auth": "Amazon SP-API OAuth + token refresh.",
  "amazon/sync-orders": "Amazon SP-API order pull.",
  "meta/api": "Marketing API client (campaigns, ad sets, insights, creatives).",
  "meta/sync-spend": "Daily Meta Ad spend rollup → [[../tables/daily_meta_ad_spend]].",
  "stores/import-store": "Zustand store for the import wizard UI.",
  "research/index": "Research-and-heal pipeline entry. See RESEARCH-AND-HEAL.md.",
  "research/types": "Research pipeline types.",
  "research/probes/loyalty": "Loyalty state probe.",
  "research/probes/subscription": "Subscription state probe.",
  "research/recipes/verify-coupon-promises": "Recipe: was a coupon promised but not applied?",
  "research/recipes/verify-grandfathered-pricing": "Recipe: was grandfathered pricing preserved?",
  "research/recipes/verify-subscription-changes": "Recipe: did promised sub changes happen?",
  "types/ticket": "Ticket-related TS types.",
  "types/workspace": "Workspace-related TS types.",
};

const GOTCHAS: Record<string, string[]> = {
  "subscription-items": [
    "`subUpdateLineItemPrice` has the 0.75 SubSave multiplier **baked in** — pass the visible MSRP, the helper applies × 0.75 before sending to Appstle. If you compute the SubSave price first, you'll end up at 0.5625 of MSRP.",
    "Every helper checks `isInternalSubscription()` first. Internal subs bypass Appstle.",
    "Variant ids must be Shopify variant ids when crossing into Appstle — internal UUIDs won't work.",
  ],
  "appstle": [
    "Internal-sub guard everywhere — `isInternalSubscription()` short-circuits before any HTTP call.",
    "Cancel must use **DELETE** with `cancellationFeedback` + `cancellationNote` — PUT to PAUSED isn't a cancel.",
    "Cancel `cancelledBy` should be the operator's `display_name`, not their full name.",
  ],
  "shopify-returns": [
    "Always go through `createFullReturn()` — never set `is_return: true` on EasyPost shipments directly (it swaps from/to addresses).",
    "`net_refund_cents` is set at creation and is the contract. Never re-derive at refund time.",
    "`freeLabel: true` = we eat the EasyPost cost; net_refund = order_total_cents.",
    "`createShopifyReturn` throws `RecoverableShopifyReturnError` for caller-handled failures (null Shopify mirror, Shopify userErrors). `createFullReturn` catches that class and returns `{ success: false, error }` WITHOUT `console.error` so a healthy recovery doesn't churn the Control Tower error feed (signature `vercel:314ca8c785aff3eb`). Unexpected throws still log.",
  ],
  "dunning": [
    "Card dedup is by `(last4, expiry_month, expiry_year, card_brand)` — Shopify can return multiple `paymentMethodToken`s for the same logical card.",
    "Terminal error codes (`card_blocked`, `do_not_honor`) short-circuit card rotation.",
    "Appstle's built-in retries + skip-after-X must be OFF — otherwise our pipeline + Appstle's will fight.",
  ],
  "remedy-selector": [
    "Per-(reason, remedy) stats kick in at 200+ data points; otherwise global stats.",
    "Open-ended chat is capped at 3 turns — never more.",
    "First-renewal customers get aggressive save offers (25-40% discounts).",
  ],
  "crypto": [
    "Encryption key is 64-char hex in `ENCRYPTION_KEY` env. Wrong length → decrypt fails silently.",
    "Don't re-encrypt already-encrypted strings. Caller must know if a value is plain or encrypted.",
  ],
  "ai-models": [
    "Model id constants are the single source of truth. Never hardcode strings elsewhere — bump the constant when models change.",
    "Don't import the Anthropic SDK directly outside `ai-models.ts` + `ai-usage.ts`.",
  ],
  "shopify-sync": [
    "Bulk operations are 1-at-a-time per shop — a stuck poll requires `cancelBulkOperation()` before restarting.",
    "GraphQL ids are GIDs (`gid://shopify/Customer/123`) — use `extractShopifyId()` for the numeric id.",
  ],
  "rag": [
    "RAG retrieval combines KB chunks + macros and returns ranked + de-duped. Don't query the two tables separately.",
    "Embedding dimension is 1536 (`text-embedding-3-small`). Changing the model requires backfilling all vectors.",
  ],
  "first-touch": [
    "Idempotent — only the first outbound touch tags ft:*. Subsequent outbound doesn't replace it.",
  ],
  "ticket-tags": [
    "Idempotent set. Calling `addTicketTag()` with an already-applied tag is a no-op.",
  ],
  "slack-notify": [
    "The catch block logs at **`console.warn`**, not `console.error` — a single `chat.postMessage` timeout is expected fire-and-forget behavior and should not be promoted into the Vercel error feed (signature `vercel:b9f34c508cec092c`). Sustained Slack delivery outages are surfaced by the `slack-delivery` Control Tower heartbeat in `src/lib/slack.ts`, not by this log line. Don't 'fix' it back to error.",
  ],
};

// ──────────────────────────────────────────────────────────────────────
// Render a page.
// ──────────────────────────────────────────────────────────────────────
function renderCallers(importPath: string): string {
  const callers = callerIndex.get(importPath);
  if (!callers || callers.size === 0) return "_No internal callers found via static scan._";
  const sorted = [...callers].sort();
  if (sorted.length > 20) {
    return sorted.slice(0, 20).map((c) => `- \`${c}\``).join("\n") + `\n- … and ${sorted.length - 20} more`;
  }
  return sorted.map((c) => `- \`${c}\``).join("\n");
}

function renderPage(abs: string): string {
  const { header, exports, importPath } = parseFile(abs);
  const filePath = relative(projectRoot, abs);
  const slug = importPath.replace(/\//g, "_");
  const summary = SUMMARIES[importPath] || (header.split("\n")[0] || "_TODO: one-line summary._");

  const exportLines: string[] = [];
  for (const e of exports) {
    if (e.kind === "function") {
      exportLines.push(`### \`${e.name}\` — function\n\n\`\`\`ts\n${e.signature}\n\`\`\``);
    } else if (e.kind === "const") {
      exportLines.push(`### \`${e.name}\` — const\n\n\`\`\`ts\n${e.signature}\n\`\`\``);
    } else if (e.kind === "class") {
      exportLines.push(`### \`${e.name}\` — class`);
    } else if (e.kind === "interface" || e.kind === "type") {
      exportLines.push(`### \`${e.name}\` — ${e.kind}`);
    } else if (e.kind === "re-export") {
      exportLines.push(`### \`${e.name}\` — ${e.signature}`);
    } else if (e.kind === "enum") {
      exportLines.push(`### \`${e.name}\` — enum`);
    }
  }
  const exportsBlock = exportLines.length ? exportLines.join("\n\n") : "_No public exports found._";

  const gotchas = GOTCHAS[importPath];
  const gotchasBlock = gotchas?.length
    ? gotchas.map((g) => `- ${g}`).join("\n")
    : "_None documented._";

  const headerBlock = header && header.length > 30 && header !== summary
    ? `\n## File header\n\n\`\`\`\n${header}\n\`\`\`\n`
    : "";

  return `# libraries/${importPath}

${summary}

**File:** \`${filePath}\`
${headerBlock}
## Exports

${exportsBlock}

## Callers

${renderCallers(importPath)}

## Gotchas

${gotchasBlock}

---

[[../README]] · [[../../CLAUDE]]
`;
}

// ──────────────────────────────────────────────────────────────────────
// Run
// ──────────────────────────────────────────────────────────────────────
let wrote = 0;
for (const abs of allLibFiles) {
  const importPath = relative(libDir, abs).replace(/\.ts$/, "");
  const outFile = resolve(outDir, importPath.replace(/\//g, "__") + ".md");
  writeFileSync(outFile, renderPage(abs));
  wrote++;
}
console.log(`Wrote ${wrote} library pages to docs/brain/libraries/`);
