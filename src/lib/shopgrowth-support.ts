import { decrypt } from "@/lib/crypto";
import { errText } from "@/lib/error-text";
import type { createAdminClient } from "@/lib/supabase/admin";

/**
 * ShopGrowth support API client for the software-mode orchestrator
 * (software-mode-orchestrator-toolset; brain: docs/brain/integrations/shopgrowth-support-api.md).
 *
 * Store data stays in ShopGrowth (data separation): it is fetched live per ticket, handed to the
 * orchestrator as compact text, and never persisted outside the ticket's own AI context. The shop +
 * app always come from the ticket's verified identity tags (`shop:<domain>` / `app:<slug>`, stamped
 * by widget-signed-identity-pass), falling back to the customer row's tags. They are NEVER taken from
 * model input, so the model cannot read or act on a store the merchant does not belong to.
 */

type Admin = ReturnType<typeof createAdminClient>;

export const SHOPGROWTH_TIMEOUT_MS = 8_000;
/** Cap on the text handed back to the model per read, so one big store can't flood the context. */
export const SHOPGROWTH_MAX_TEXT = 6_000;

export const SHOPGROWTH_STORE_SECTIONS = ["summary", "events", "flags", "orders", "order", "chargebacks"] as const;
export type ShopgrowthStoreSection = (typeof SHOPGROWTH_STORE_SECTIONS)[number];

export interface ShopgrowthStoreKey {
  shop: string;
  app: string;
}

export interface ShopgrowthConfig {
  apiBase: string;
  token: string;
}

/** Read `shop:<domain>` + `app:<slug>` from a tag list. Both must be present; first match wins. */
export function storeKeyFromTags(tags: readonly string[] | null | undefined): ShopgrowthStoreKey | null {
  let shop: string | null = null;
  let app: string | null = null;
  for (const raw of tags ?? []) {
    const t = String(raw).trim();
    if (!shop && t.startsWith("shop:") && t.length > 5) shop = t.slice(5).trim();
    if (!app && t.startsWith("app:") && t.length > 4) app = t.slice(4).trim();
  }
  return shop && app ? { shop, app } : null;
}

/** Ticket tags (the verified pass) win; the customer row's tags are the fallback. */
export function resolveStoreKey(
  ticketTags: readonly string[] | null | undefined,
  customerTags: readonly string[] | null | undefined,
): ShopgrowthStoreKey | null {
  return storeKeyFromTags(ticketTags) ?? storeKeyFromTags(customerTags);
}

/** Build the read URL for one section. Pure so the endpoint mapping is unit-testable. */
export function buildStoreReadUrl(
  apiBase: string,
  key: ShopgrowthStoreKey,
  input: { section?: string | null; order?: string | null; since?: string | null },
): string {
  const base = apiBase.replace(/\/+$/, "");
  const section = (SHOPGROWTH_STORE_SECTIONS as readonly string[]).includes(String(input.section ?? ""))
    ? (input.section as ShopgrowthStoreSection)
    : "summary";
  const q = new URLSearchParams({ shop: key.shop, app: key.app });
  let path: string;
  switch (section) {
    case "events":
    case "flags":
      path = "/api/support/v1/events";
      q.set("limit", "50");
      if (section === "flags") q.set("type", "flag");
      if (input.since) q.set("since", String(input.since));
      break;
    case "orders":
    case "order":
      path = "/api/support/v1/orders";
      if (input.order) q.set("order", String(input.order));
      if (input.since) q.set("since", String(input.since));
      break;
    case "chargebacks":
      path = "/api/support/v1/chargebacks";
      if (input.since) q.set("since", String(input.since));
      break;
    default:
      path = "/api/support/v1/store";
  }
  return `${base}${path}?${q.toString()}`;
}

/** Compact a JSON/text body for the model: stable JSON, hard-capped. */
export function compactBody(body: string, max = SHOPGROWTH_MAX_TEXT): string {
  let text = body.trim();
  try {
    text = JSON.stringify(JSON.parse(text));
  } catch {
    /* not JSON — keep the raw text */
  }
  return text.length > max ? `${text.slice(0, max)}… [truncated]` : text;
}

/**
 * Store-side changes the AI may never make, whatever ShopGrowth would accept: the merchant's own
 * ShopGrowth plan/billing, uninstalling, and data deletion. For these the AI links the merchant to the
 * app's Plans page (or escalates) instead.
 */
const FORBIDDEN_ACTION_RE = /(plan|billing|subscription|charge_?app|uninstall|delete_?(store|shop|data|account)|data_?deletion|erase|gdpr)/i;
export function isForbiddenShopgrowthAction(action: string): boolean {
  return FORBIDDEN_ACTION_RE.test(action);
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
}

const AFFIRM_RE = /\b(yes|yeah|yep|yup|sure|ok|okay|please do|go ahead|do it|confirm(ed)?|sounds good|that works|correct)\b/i;
const NEGATE_RE = /\b(no|nope|don'?t|do not|stop|cancel that|wait|hold off|not yet)\b/i;

/**
 * Is the latest inbound merchant message an explicit confirmation of the proposed action? The model
 * must quote the confirming words (`confirmation_quote`); the quote has to appear verbatim in the
 * latest inbound message, and that message must read as an affirmation, not a refusal. Deterministic
 * so a model that only thinks it heard a yes cannot act on the store.
 */
export function isShopgrowthActionConfirmed(latestInbound: string | null | undefined, quote: string | null | undefined): boolean {
  const msg = normalize(String(latestInbound ?? ""));
  const q = normalize(String(quote ?? ""));
  if (!msg || !q || q.length < 2) return false;
  if (!msg.includes(q)) return false;
  if (!AFFIRM_RE.test(q) && !AFFIRM_RE.test(msg)) return false;
  if (NEGATE_RE.test(q)) return false;
  return true;
}

/** Workspace credentials for the ShopGrowth support API, or null when not configured. */
export async function getShopgrowthConfig(admin: Admin, workspaceId: string): Promise<ShopgrowthConfig | null> {
  const { data } = await admin
    .from("workspaces")
    .select("shopgrowth_api_base, shopgrowth_support_token_encrypted")
    .eq("id", workspaceId)
    .maybeSingle();
  const row = data as { shopgrowth_api_base?: string | null; shopgrowth_support_token_encrypted?: string | null } | null;
  const apiBase = (row?.shopgrowth_api_base ?? "").trim();
  const enc = (row?.shopgrowth_support_token_encrypted ?? "").trim();
  if (!apiBase || !enc) return null;
  try {
    return { apiBase, token: decrypt(enc) };
  } catch {
    return null;
  }
}

/** The ticket's verified store, from ticket tags then customer tags. */
export async function getTicketStoreKey(
  admin: Admin,
  ticketId: string,
  customerId: string | null,
): Promise<ShopgrowthStoreKey | null> {
  const [{ data: ticket }, { data: customer }] = await Promise.all([
    admin.from("tickets").select("tags").eq("id", ticketId).maybeSingle(),
    customerId
      ? admin.from("customers").select("tags").eq("id", customerId).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  return resolveStoreKey(
    ((ticket as { tags?: string[] } | null)?.tags ?? null),
    ((customer as { tags?: string[] } | null)?.tags ?? null),
  );
}

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), SHOPGROWTH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** The get_shopgrowth_store tool: one read-only section of the merchant's live store state, as text. */
export async function getShopgrowthStore(
  admin: Admin,
  workspaceId: string,
  ticketId: string,
  customerId: string | null,
  input: { section?: string | null; order?: string | null; since?: string | null },
): Promise<string> {
  const cfg = await getShopgrowthConfig(admin, workspaceId);
  if (!cfg) return "ShopGrowth store data is not connected for this workspace. Answer from the knowledge base; do not guess at the merchant's store state.";
  const key = await getTicketStoreKey(admin, ticketId, customerId);
  if (!key) return "This chat has no verified store (shop + app). Ask the merchant to open the chat from inside the app so we can see their store; do not guess at their store state.";
  const url = buildStoreReadUrl(cfg.apiBase, key, input);
  try {
    const res = await timedFetch(url, { headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/json" } });
    if (res.status === 404) return `That store data (${input.section || "summary"}) is not available yet from ShopGrowth. Say so if it matters; do not guess.`;
    const body = await res.text();
    if (!res.ok) return `ShopGrowth returned ${res.status} for ${input.section || "summary"}. Treat the store state as unknown.`;
    return `ShopGrowth ${input.section || "summary"} for ${key.shop} (${key.app}): ${compactBody(body)}`;
  } catch (e) {
    return `ShopGrowth store read failed (${errText(e)}). Treat the store state as unknown.`;
  }
}

export type ShopgrowthActionResult =
  | { kind: "ok"; summary: string }
  | { kind: "not_live" }
  | { kind: "failed"; status: number | null; detail: string };

/** POST one confirmed action. ShopGrowth owns the allow-list + validation and returns {ok, summary}. */
export async function postShopgrowthAction(
  cfg: ShopgrowthConfig,
  key: ShopgrowthStoreKey,
  body: { action: string; params: Record<string, unknown>; ticket_id: string },
): Promise<ShopgrowthActionResult> {
  const url = `${cfg.apiBase.replace(/\/+$/, "")}/api/support/v1/actions`;
  try {
    const res = await timedFetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ shop: key.shop, app: key.app, action: body.action, params: body.params, ticket_id: body.ticket_id }),
    });
    if (res.status === 404) return { kind: "not_live" };
    const text = await res.text();
    let parsed: { ok?: boolean; summary?: string } | null = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (res.ok && parsed?.ok === true && typeof parsed.summary === "string" && parsed.summary.trim()) {
      return { kind: "ok", summary: parsed.summary.trim() };
    }
    return { kind: "failed", status: res.status, detail: compactBody(text, 500) };
  } catch (e) {
    return { kind: "failed", status: null, detail: errText(e) };
  }
}
