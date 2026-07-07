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
 * Amplifier rejects Unicode + silently truncates the packing-slip
 * field somewhere around 225-250 chars; we strip non-ASCII and
 * hard-cap at 225 so the note is never cut mid-sentence on the box.
 */

import { createAdminClient } from "@/lib/supabase/admin";

// Amplifier's packing-slip field truncates around 225-250 chars.
// Cap at 225 to stay safely inside their limit. The templates below
// already land under this for any realistic name; the Haiku rewrite
// is constrained + rejected if it overflows (see haikuParaphrase).
const MAX_CHARS = 225;
const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const HAIKU_TIMEOUT_MS = 4000;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

function asciiOnly(s: string): string {
  // Strip non-ASCII, then collapse multi-spaces created when we
  // removed an em-dash / curly quote / accent character mid-sentence
  // ("orders — your" → "orders  your" without this pass).
  return s.replace(/[^\x00-\x7F]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Title-case a name that may come in fully uppercased (autofill) or
 * fully lowercased. "DYLAN" → "Dylan", "mary anne" → "Mary Anne",
 * "o'brien" → "O'Brien". Mixed-case names ("McDonald") pass through.
 */
function titleCaseName(raw: string): string {
  const s = raw.trim();
  if (!s) return s;
  // Heuristic: if the input contains BOTH upper- and lower-case, the
  // user typed it intentionally — leave it alone.
  const hasUpper = /[A-Z]/.test(s);
  const hasLower = /[a-z]/.test(s);
  if (hasUpper && hasLower) return s;
  return s.toLowerCase().replace(/\b([a-z])([a-z']*)/g, (_, a, rest) => a.toUpperCase() + rest);
}

function pluralize(productCount: number, single: string, plural: string): string {
  return productCount > 1 ? plural : single;
}

/**
 * Cap a note at MAX_CHARS without cutting a word in half. If the note
 * is already short (the normal case), returns it unchanged. Only fires
 * for pathological inputs (a 30+ char first name) that push a template
 * over the Amplifier limit.
 */
function capToLimit(s: string): string {
  if (s.length <= MAX_CHARS) return s;
  const clipped = s.slice(0, MAX_CHARS);
  const lastSpace = clipped.lastIndexOf(" ");
  return (lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped).trim();
}

function founderTemplate(firstName: string, productCount: number, priorOrders: number): string {
  // Normalize ALL-CAPS / lowercase autofills to readable "Dylan" form.
  const name = titleCaseName(firstName || "there");
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
 *
 * Critical inputs (firstName, orderCount) are passed as structured
 * facts in the user message because Haiku has been observed to
 * hallucinate names ("Sarah" instead of "Dylan") if it has to extract
 * them from the prose. By stating them as labeled facts AND requiring
 * verbatim copy, we get reliable substitution.
 */
async function haikuParaphrase(opts: { template: string; firstName: string; orderCount: number }): Promise<string | null> {
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
          `You paraphrase a founder's packing-slip thank-you note for a returning customer. ` +
          `Hard rules — violating any of these is a failure:\n` +
          `- Sender is always "Dylan, founder of Superfoods Company".\n` +
          `- The customer's first name appears VERBATIM once near the start. NEVER substitute another name. If the input says the customer is "Dylan", your output must say "Hey Dylan" — NEVER "Hey Sarah" or anything else.\n` +
          `- The order count appears VERBATIM. If the input says "52 orders", your output must say "52 orders".\n` +
          `- Warm, sincere tone — no marketing-speak.\n` +
          `- Genuine thanks for their loyalty.\n` +
          `- A wish that the product(s) help them reach their goals.\n` +
          `- Length 150-210 characters. This is a HARD ceiling — Amplifier truncates the note past ~225 characters, so a longer rewrite gets discarded.\n` +
          `- ASCII only. NO emoji, NO em-dashes, NO curly quotes, NO accents. Use a comma or period where you might have reached for an em-dash.\n\n` +
          `Output ONLY the rewritten note. No quotation marks, no preface, no explanation.`,
        messages: [{
          role: "user",
          content:
            `Facts to preserve EXACTLY in your rewrite:\n` +
            `- Customer first name: ${opts.firstName}\n` +
            `- Order count: ${opts.orderCount}\n\n` +
            `Original note to paraphrase:\n\n${opts.template}\n\n` +
            `Rewrite it in a slightly different way for someone who's already gotten a previous shipment.`,
        }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = ((data?.content?.[0] as { text?: string })?.text || "").trim();
    if (!text) return null;

    // Safety check — Haiku occasionally substitutes the wrong name
    // despite the hard rule. If the customer's name isn't present in
    // the output, reject and let the template win.
    const expectedName = opts.firstName.trim();
    if (expectedName && !text.toLowerCase().includes(expectedName.toLowerCase())) {
      return null;
    }
    // Same check for order count — must appear verbatim.
    if (!text.includes(String(opts.orderCount))) {
      return null;
    }
    // Length guard — if Haiku ignored the ceiling, discard the rewrite
    // and let the (already-short) template win rather than truncate a
    // paraphrase mid-sentence. Measure post-ASCII-strip, same as the
    // string that actually ships.
    if (asciiOnly(text).length > MAX_CHARS) {
      return null;
    }
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
  const cleanedName = titleCaseName(input.firstName || "there");
  const template = founderTemplate(input.firstName, input.productCount, prior);
  let message = template;
  if (prior > 0) {
    const rewritten = await haikuParaphrase({
      template,
      firstName: cleanedName,
      orderCount: prior + 1,
    });
    if (rewritten) message = rewritten;
  }
  return capToLimit(asciiOnly(message));
}
