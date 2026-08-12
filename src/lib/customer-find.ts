/**
 * libraries/customer-find — locate a customer from identifiers the customer SUPPLIES IN THE
 * CONVERSATION (name / phone / address / a different email), rather than from an existing record.
 *
 * WHY THIS EXISTS. Every one of the orchestrator's 14 data tools assumes the customer is already
 * identified — `get_customer_account`, `get_customer_timeline`, `get_returns` all take a
 * `customerId`. There was NO tool that could find one. So when the inbound email didn't resolve to
 * an account, the orchestrator's only legal move was to escalate, and it did so while literally
 * narrating the search it could not perform:
 *
 *     "Since we can't locate their account by email, this needs a human agent to search by
 *      name/address."   — ticket 879dd36b, 2026-08-12
 *
 * The customer had already given us his full name, street address and phone in the previous
 * message. Nothing searched on any of them.
 *
 * WHY NOT `account-matching.findUnlinkedMatches`. That function answers a different question —
 * "which OTHER records look like this EXISTING customer?" — and reads the identity fields off a
 * populated `customers` row. In the failing case the row is a stub the ticket itself minted 35ms
 * earlier (email only, `first_name`/`phone`/`default_address` all null), so it has nothing to match
 * ON. This module takes the identifiers as ARGUMENTS instead, which is the shape a conversation
 * actually provides.
 *
 * The GRADING is not re-implemented: candidates are scored by the same pure
 * `gradeUnlinkedCandidates` the linking flow uses, so "high" means the same thing on both surfaces
 * (a shared address corroborating a surname, or a shared phone) and the two can never drift.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import {
  gradeUnlinkedCandidates,
  normAddr,
  type CandidateInput,
  type MatchSignal,
  type PotentialMatch,
} from "@/lib/account-matching";

type Admin = ReturnType<typeof createAdminClient>;

/** Identifiers a customer can hand us mid-conversation. All optional; at least one is required. */
export interface FindCustomerInput {
  /** full name as written ("Mark McCartney") or just a surname. */
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  /** street line as written ("16815 328th Ave"). */
  address1?: string | null;
  zip?: string | null;
}

export interface FindCustomerResult {
  matches: PotentialMatch[];
  /** every identifier actually used — so the agent can say what it searched, not guess. */
  searched: MatchSignal[];
  /** true when at least one identifier was usable. A no-op search must never read as "no account". */
  searchable: boolean;
}

/** Digits-only phone key so "612 388-1773", "+16123881773" and "6123881773" all compare equal. */
export function phoneKey(v: unknown): string {
  const d = String(v ?? "").replace(/\D+/g, "");
  return d.length > 10 ? d.slice(-10) : d; // drop a leading country code
}

/** Split a written name into a surname for matching ("Mark McCartney" → "mccartney"). */
export function surnameOf(name: unknown): string {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  return parts.length ? normAddr(parts[parts.length - 1]) : "";
}

/**
 * Search `customers` on any supplied identifier, then grade the candidates with the SHARED grader.
 *
 * One indexed query per supplied signal (mirrors `findUnlinkedMatches`' branch shape), merged in
 * memory. Never throws — a lookup failure returns `searchable:false` with no matches, so a caller
 * can distinguish "we searched and found nobody" from "we could not search", which is exactly the
 * distinction the failing ticket collapsed.
 */
export async function findCustomerByIdentifiers(
  admin: Admin,
  workspaceId: string,
  input: FindCustomerInput,
): Promise<FindCustomerResult> {
  const searched: MatchSignal[] = [];
  const byId = new Map<string, CandidateInput>();

  type Row = {
    id: string;
    email: string;
    phone: string | null;
    first_name: string | null;
    last_name: string | null;
    default_address: Record<string, unknown> | null;
  };
  const select = "id, email, phone, first_name, last_name, default_address";
  const add = (rows: Row[] | null, signal: MatchSignal) => {
    for (const r of rows ?? []) {
      const prev = byId.get(r.id);
      const addr = (r.default_address ?? {}) as Record<string, unknown>;
      if (prev) { if (!prev.signals.includes(signal)) prev.signals.push(signal); continue; }
      byId.set(r.id, {
        id: r.id,
        email: r.email,
        last_name: r.last_name,
        address1: addr.address1 ?? null,
        zip: addr.zip ?? null,
        signals: [signal],
      });
    }
  };

  try {
    const surname = surnameOf(input.name);
    if (surname) {
      searched.push("name");
      const { data } = await admin.from("customers").select(select)
        .eq("workspace_id", workspaceId).ilike("last_name", surname).limit(25);
      add(data as Row[] | null, "name");
    }

    const pk = phoneKey(input.phone);
    if (pk.length >= 10) {
      searched.push("phone");
      // Stored formats vary (+1…, bare 10-digit); match on the trailing 10 digits.
      const { data } = await admin.from("customers").select(select)
        .eq("workspace_id", workspaceId).ilike("phone", `%${pk}%`).limit(25);
      add(data as Row[] | null, "phone");
    }

    const email = String(input.email ?? "").trim().toLowerCase();
    if (email.includes("@")) {
      searched.push("email");
      const { data } = await admin.from("customers").select(select)
        .eq("workspace_id", workspaceId).ilike("email", email).limit(25);
      add(data as Row[] | null, "email");
    }

    // Address is the strongest corroborator, so it is also searched DIRECTLY (not only used to
    // grade a name hit) — a spouse/relative ordering under a different surname is exactly the case
    // an email lookup misses, and it is the case the failing ticket was.
    const a1 = normAddr(input.address1);
    if (a1) {
      searched.push("address");
      const { data } = await admin.from("customers").select(select)
        .eq("workspace_id", workspaceId).ilike("default_address->>address1", `%${a1}%`).limit(25);
      add(data as Row[] | null, "address");
    }
  } catch (e) {
    console.warn("[customer-find] lookup failed:", e instanceof Error ? e.message : e);
    return { matches: [], searched, searchable: searched.length > 0 };
  }

  if (!searched.length) return { matches: [], searched, searchable: false };

  const matches = gradeUnlinkedCandidates(
    { last_name: surnameOf(input.name) || null, address1: input.address1 ?? null, zip: input.zip ?? null },
    [...byId.values()],
    new Set<string>(),
    new Set<string>(),
  );
  return { matches, searched, searchable: true };
}

/**
 * Render the result for the orchestrator's tool channel.
 *
 * The wording is deliberate. "Searched X, Y — no customer record matches" is a FACT the agent may
 * state; it must never be softened into a guess, and an empty result must never be narrated as
 * "I can see you've been receiving shipments" (the 2026-08-12 hallucination this tool replaces).
 */
export function findCustomerToText(r: FindCustomerResult): string {
  if (!r.searchable) {
    return "NO IDENTIFIERS SUPPLIED — nothing was searched. Ask the customer for the name, street address, or phone on the order. Do NOT state or imply that no account exists; you have not looked.";
  }
  const searched = r.searched.join(", ");
  if (!r.matches.length) {
    return `Searched ${searched} — NO customer record matches. This person may not be our customer, or ordered under a different person's account (spouse, gift-giver). Say plainly that you cannot find an account on those details and ask whether the order may have been placed under another name, email, or card. Do NOT promise a cancellation or refund: with no account there is nothing verified to act on.`;
  }
  const lines = r.matches.map((m) => `- ${m.email} (id ${m.id}) — confidence ${m.confidence}, matched on ${m.signals.join("+")}${m.previously_rejected ? " [a prior link was rejected — re-confirm, never auto-link]" : ""}`);
  return `Searched ${searched} — ${r.matches.length} candidate account(s):\n${lines.join("\n")}\n\nA 'high' candidate shares an address corroborating the surname, or a phone number. NEVER act on a candidate without confirming identity with the customer first, and never reveal another account's details.`;
}
