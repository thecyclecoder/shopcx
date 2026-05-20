/**
 * Packing-slip "founder note" for Amplifier orders.
 *
 * Template (Superfoods Co):
 *   "Hey {first_name}, it's Dylan the founder of Superfoods Company.
 *    So glad to have you in the superfoods family. We hope you really
 *    enjoy {this product / these products} and that they help you
 *    reach your goals!"
 *
 * First-time customers get the template verbatim (a clean first
 * impression). Repeat customers get a Haiku rewrite — same sender,
 * same warmth, same length, just a fresh phrasing so the box doesn't
 * become a copy-paste experience over 12 cycles.
 *
 * Amplifier rejects Unicode + caps the field at 2000 chars; we strip
 * non-ASCII and hard-cap at 1800 to leave headroom.
 */

import { createAdminClient } from "@/lib/supabase/admin";

const MAX_CHARS = 1800;
const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const HAIKU_TIMEOUT_MS = 4000;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

function asciiOnly(s: string): string {
  return s.replace(/[^\x00-\x7F]/g, "").trim();
}

function pluralize(productCount: number, single: string, plural: string): string {
  return productCount > 1 ? plural : single;
}

function founderTemplate(firstName: string, productCount: number, priorOrders: number): string {
  const name = (firstName || "there").trim();
  const product = pluralize(productCount, "this product", "these products");
  // First-timers: warm welcome. Repeats: count + thanks.
  if (priorOrders === 0) {
    return (
      `Hey ${name}, it's Dylan the founder of Superfoods Company. ` +
      `So glad to have you in the superfoods family. ` +
      `We hope you really enjoy ${product} and that they help you reach your goals!`
    );
  }
  const totalOrders = priorOrders + 1; // current order included in the thanks
  return (
    `Hey ${name}, it's Dylan the founder of Superfoods Company. ` +
    `Thank you so much for your ${totalOrders} orders with us — it means the world. ` +
    `We hope you really enjoy ${product} and that they keep helping you reach your goals!`
  );
}

/**
 * Counts non-cancelled orders the customer has placed BEFORE the
 * given orderId, across all linked accounts. Returns 0 for true
 * first-timers.
 */
async function priorOrderCount(workspaceId: string, customerId: string, currentOrderId: string): Promise<number> {
  const admin = createAdminClient();
  const ids = await linkedCustomerIds(workspaceId, customerId);
  const { count } = await admin
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .in("customer_id", ids)
    .neq("id", currentOrderId);
  return count || 0;
}

async function linkedCustomerIds(workspaceId: string, customerId: string): Promise<string[]> {
  const admin = createAdminClient();
  const { data: link } = await admin
    .from("customer_links")
    .select("group_id")
    .eq("customer_id", customerId)
    .maybeSingle();
  if (!link?.group_id) return [customerId];
  const { data: group } = await admin
    .from("customer_links")
    .select("customer_id")
    .eq("group_id", link.group_id);
  void workspaceId;
  const ids = (group || []).map((r) => r.customer_id as string);
  return ids.length > 0 ? ids : [customerId];
}

/**
 * Ask Haiku to paraphrase the template. Constraints in the system
 * prompt: keep sender, tone, length range, ASCII-only. Returns the
 * raw template on any failure (timeout, missing key, parse error) —
 * a bad rewrite shouldn't block fulfillment.
 */
async function haikuParaphrase(template: string): Promise<string | null> {
  if (!ANTHROPIC_API_KEY) return null;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), HAIKU_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 400,
        system:
          `You paraphrase a founder's packing-slip thank-you note for a returning customer. Keep:\n` +
          `- The exact sender ("Dylan, founder of Superfoods Company")\n` +
          `- The same warm, sincere tone — no marketing-speak\n` +
          `- The customer's first name appearing once near the start\n` +
          `- The exact order count from the original (e.g. if it says "6 orders", your rewrite must also say "6 orders" — never change the number)\n` +
          `- A genuine thanks for their loyalty\n` +
          `- A wish that the product(s) help them reach their goals\n` +
          `- Length 180–320 characters\n` +
          `- ASCII only — NO emoji, NO em-dashes, NO curly quotes, NO accents\n\n` +
          `Output ONLY the rewritten note. No quotation marks, no preface, no explanation.`,
        messages: [{ role: "user", content: `Original note:\n\n${template}\n\nRewrite it in a slightly different way for someone who's already gotten a previous shipment.` }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = ((data?.content?.[0] as { text?: string })?.text || "").trim();
    if (!text) return null;
    return text;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export interface BuildPackingSlipInput {
  workspaceId: string;
  customerId: string;
  orderId: string;             // exclude this from "prior orders" count
  firstName: string;
  productCount: number;        // distinct chargeable products (gifts can count or not — caller's choice)
}

/**
 * Build the packing-slip message for an order.
 * - First-time customer (no prior orders): verbatim warm-welcome
 *   template.
 * - Returning customer: order-count thanks template, then Haiku
 *   rewrite to a different phrasing so cycle 6 doesn't read like
 *   cycle 5. Falls back to the template on any AI error so
 *   fulfillment never stalls.
 */
export async function buildPackingSlipMessage(input: BuildPackingSlipInput): Promise<string> {
  let prior = 0;
  try {
    prior = await priorOrderCount(input.workspaceId, input.customerId, input.orderId);
  } catch { /* treat as first-time on any lookup failure */ }
  const template = founderTemplate(input.firstName, input.productCount, prior);
  let message = template;
  if (prior > 0) {
    const rewritten = await haikuParaphrase(template);
    if (rewritten) message = rewritten;
  }
  return asciiOnly(message).slice(0, MAX_CHARS);
}
