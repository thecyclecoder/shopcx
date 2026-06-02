/**
 * Match a Meta social-comment sender (display name from FB/IG) to one
 * or more `customers` rows. Common case: "Suzy Doucet" on FB →
 * "Suzanne Doucet" in our DB.
 *
 * Strategy:
 *   1. Last name exact match (case-insensitive) — anchors the match.
 *   2. Among those, score first-name similarity:
 *        a. exact match               → score 100
 *        b. one is a prefix of other  → 90
 *        c. nickname dictionary hit   → 85
 *        d. shared 3+ char prefix     → 70
 *        else excluded
 *   3. Roll up to linked-account groups so duplicate profiles for the
 *      same person show as one candidate (we surface the canonical
 *      customer — the one with the most activity).
 *   4. Enrich with ticket count + LTV + last-order date + active-sub
 *      flag so the UI can render rich cards.
 *
 * Cheap: 2-3 DB queries, no AI. Returns up to 5 candidates ranked by
 * (name score) then (active sub) then (LTV).
 */

import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

// Bidirectional nickname dictionary. Each entry maps a canonical
// first name to its common nicknames; we expand both directions at
// query time. Conservative — only well-known pairs to avoid wrong
// matches (e.g. "Jen" → "Jennifer" but not "Jen" → "Jenny" as
// separate match).
const NICKNAME_MAP: Record<string, string[]> = {
  suzanne: ["suzy", "sue", "suz", "susie", "susi"],
  susan: ["sue", "susie", "susi", "suzy"],
  robert: ["bob", "rob", "bobby", "robby"],
  william: ["bill", "billy", "will", "willy"],
  richard: ["rick", "rich", "dick", "richie"],
  michael: ["mike", "mickey", "mick"],
  james: ["jim", "jimmy", "jamie"],
  john: ["johnny", "jack"],
  joseph: ["joe", "joey"],
  charles: ["charlie", "chuck", "chas"],
  thomas: ["tom", "tommy"],
  edward: ["ed", "eddie", "ted", "teddy"],
  daniel: ["dan", "danny"],
  david: ["dave", "davey"],
  christopher: ["chris", "topher"],
  matthew: ["matt", "matty"],
  anthony: ["tony"],
  nicholas: ["nick", "nicky"],
  andrew: ["andy", "drew"],
  jonathan: ["jon", "jonny"],
  benjamin: ["ben", "benny"],
  alexander: ["alex", "al", "xander"],
  patrick: ["pat", "paddy"],
  samuel: ["sam", "sammy"],
  steven: ["steve", "stevie"],
  stephen: ["steve", "stevie"],
  timothy: ["tim", "timmy"],
  gregory: ["greg"],
  jeffrey: ["jeff"],
  douglas: ["doug"],
  ronald: ["ron", "ronny"],
  donald: ["don", "donny"],
  kenneth: ["ken", "kenny"],
  lawrence: ["larry"],
  zachary: ["zach", "zack"],
  raymond: ["ray"],
  vincent: ["vinny", "vince"],
  henry: ["hank", "harry"],
  elizabeth: ["liz", "beth", "betty", "lizzy", "eliza", "ellie", "betsy"],
  catherine: ["cathy", "kate", "katie", "kat", "cat"],
  katherine: ["kathy", "kate", "katie", "kat"],
  margaret: ["maggie", "meg", "peggy", "marge"],
  patricia: ["pat", "patty", "tricia", "trish"],
  jennifer: ["jen", "jenny", "jenn"],
  jessica: ["jess", "jessie"],
  rebecca: ["becca", "becky"],
  deborah: ["deb", "debbie"],
  barbara: ["barb", "babs"],
  victoria: ["vicky", "tori"],
  caroline: ["carrie", "caro"],
  kimberly: ["kim", "kimmy"],
  michelle: ["shelly", "mich"],
  christina: ["chris", "tina", "christy"],
  christine: ["chris", "tina", "christy"],
  cynthia: ["cindy"],
  sharon: ["shari"],
  pamela: ["pam"],
  cheryl: ["cher"],
  amanda: ["mandy"],
  natalie: ["nat", "tally"],
  nicole: ["nikki"],
  rachel: ["rachie"],
  diana: ["di"],
  alexandra: ["alex", "lexi", "sandra", "ali"],
  isabella: ["bella", "izzy", "isa"],
  abigail: ["abby", "abi"],
  veronica: ["roni"],
  gabrielle: ["gabby", "gabi"],
};

function normName(s: string | null | undefined): string {
  return (s || "").trim().toLowerCase().replace(/[^a-z]/g, "");
}

function nicknameMatch(a: string, b: string): boolean {
  // Both directions: a in NICKNAME_MAP[b]'s aliases, OR b in NICKNAME_MAP[a]'s aliases
  if (NICKNAME_MAP[a]?.includes(b)) return true;
  if (NICKNAME_MAP[b]?.includes(a)) return true;
  return false;
}

function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

function nameScore(commentFirst: string, dbFirst: string): number {
  const a = normName(commentFirst);
  const b = normName(dbFirst);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.length >= 3 && b.startsWith(a)) return 90;
  if (b.length >= 3 && a.startsWith(b)) return 90;
  if (nicknameMatch(a, b)) return 85;
  if (commonPrefixLen(a, b) >= 3) return 70;
  return 0;
}

export interface CustomerCandidate {
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  shopify_customer_id: string | null;
  ltv_cents: number | null;
  subscription_status: string | null;
  has_active_sub: boolean;
  ticket_count: number;
  last_order_at: string | null;
  /** 0-100: how confident we are this is the same person. */
  match_score: number;
}

/**
 * Find customers that plausibly match a Meta display name.
 *
 * Always returns the BEST candidate per linked-account group; we
 * don't surface 4 versions of the same person.
 */
export async function findCustomerCandidatesByMetaName(
  admin: Admin,
  workspaceId: string,
  metaSenderName: string | null,
): Promise<CustomerCandidate[]> {
  const parts = (metaSenderName || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return [];
  const firstName = parts[0];
  const lastName = parts[parts.length - 1];

  // Last-name exact (case-insensitive). ilike supports the case for us;
  // no wildcard needed.
  const { data: byLast } = await admin
    .from("customers")
    .select("id, email, first_name, last_name, shopify_customer_id, ltv_cents, subscription_status")
    .eq("workspace_id", workspaceId)
    .ilike("last_name", lastName);

  if (!byLast?.length) return [];

  // Score + filter
  const scored = byLast
    .map(c => ({
      ...c,
      match_score: nameScore(firstName, c.first_name as string),
    }))
    .filter(c => c.match_score > 0);

  if (!scored.length) return [];

  // Roll up linked-account groups — keep the highest-scoring (then
  // most-active) row per group_id.
  const ids = scored.map(c => c.id as string);
  const { data: links } = await admin
    .from("customer_links")
    .select("customer_id, group_id")
    .in("customer_id", ids);
  const groupByCust = new Map<string, string>();
  for (const l of links || []) groupByCust.set(l.customer_id as string, l.group_id as string);

  // Order: score desc, then we need activity to break ties — pull
  // ticket counts + order activity once for the candidates.
  const { data: ticketCounts } = await admin
    .from("tickets")
    .select("customer_id")
    .eq("workspace_id", workspaceId)
    .in("customer_id", ids);
  const ticketByCust = new Map<string, number>();
  for (const t of ticketCounts || []) {
    const k = t.customer_id as string;
    ticketByCust.set(k, (ticketByCust.get(k) || 0) + 1);
  }

  const { data: lastOrders } = await admin
    .from("orders")
    .select("customer_id, created_at")
    .eq("workspace_id", workspaceId)
    .in("customer_id", ids)
    .order("created_at", { ascending: false });
  const lastOrderByCust = new Map<string, string>();
  for (const o of lastOrders || []) {
    const k = o.customer_id as string;
    if (!lastOrderByCust.has(k)) lastOrderByCust.set(k, o.created_at as string);
  }

  // Group candidates; pick best per group
  const byGroup = new Map<string, typeof scored[number] & {
    has_active_sub: boolean; ticket_count: number; last_order_at: string | null;
  }>();
  for (const c of scored) {
    const has_active_sub = c.subscription_status === "active";
    const ticket_count = ticketByCust.get(c.id as string) || 0;
    const last_order_at = lastOrderByCust.get(c.id as string) || null;
    const enriched = { ...c, has_active_sub, ticket_count, last_order_at };
    const groupKey = groupByCust.get(c.id as string) || `solo:${c.id}`;
    const incumbent = byGroup.get(groupKey);
    if (!incumbent) { byGroup.set(groupKey, enriched); continue; }
    // Tie-break: score, then active sub, then ticket count, then LTV
    const better =
      enriched.match_score > incumbent.match_score ? true :
      enriched.match_score < incumbent.match_score ? false :
      enriched.has_active_sub && !incumbent.has_active_sub ? true :
      !enriched.has_active_sub && incumbent.has_active_sub ? false :
      enriched.ticket_count > incumbent.ticket_count ? true :
      enriched.ticket_count < incumbent.ticket_count ? false :
      (enriched.ltv_cents || 0) > (incumbent.ltv_cents || 0);
    if (better) byGroup.set(groupKey, enriched);
  }

  return [...byGroup.values()]
    .sort((a, b) =>
      b.match_score - a.match_score ||
      Number(b.has_active_sub) - Number(a.has_active_sub) ||
      b.ticket_count - a.ticket_count ||
      (b.ltv_cents || 0) - (a.ltv_cents || 0))
    .slice(0, 5);
}
