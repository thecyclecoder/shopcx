/**
 * Ticket c969f235 — retire every customer-facing pointer to the SHOPIFY account
 * page and replace it with OUR portal.
 *
 * The code surfaces ship in the same PR (portal payloads, dunning payload, and
 * the orchestrator knowledge block all resolve through `src/lib/portal-urls.ts`).
 * TWO of the six surfaces live in the database, so they need this backfill:
 *
 *   1. `workspaces.portal_config.general.payment_update_url` — the operator-set
 *      value rendered on /dashboard/settings/portal.
 *   2. The approved `sonnet_prompts` knowledge entry "Payment method update —
 *      exact URL and instructions", which hardcodes the Shopify URL *and*
 *      Shopify-shaped steps ("scroll to Payment Methods, click Add"). Replaced
 *      via the sonnet-prompts SDK supersede lifecycle (propose → manual accept →
 *      archive the old row), never a raw update — CLAUDE.md § chokepoints.
 *
 * Idempotent: re-running after a successful pass finds the new URL already in
 * place and the old prompt archived, and writes nothing.
 *
 * Dry-run by default. Pass --apply to write.
 */
import "./_bootstrap";
import { createAdminClient } from "../src/lib/supabase/admin";
import {
  proposePrompt,
  applyManualOverride,
  archiveSupersededPrompt,
} from "../src/lib/sonnet-prompts-table";
import { getPaymentMethodsUrl } from "../src/lib/portal-urls";

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
/** Dylan (owner) — stamped on `reviewed_by` for the supersede. */
const ACTOR = "496c3592-d105-4bf3-a3bb-1d2922405fb9";
const TICKET_ID = "c969f235-f3f1-4575-9139-6f906338c395";
const PROMPT_TITLE = "Payment method update — exact URL and instructions";
const STALE_HOST = "account.superfoodscompany.com";

const APPLY = process.argv.includes("--apply");
const log = (m: string) => console.log(`${APPLY ? "[apply]" : "[dry-run]"} ${m}`);

async function main() {
  const admin = createAdminClient();
  const portalUrl = await getPaymentMethodsUrl(WORKSPACE_ID);
  if (portalUrl.includes(STALE_HOST)) {
    throw new Error(`resolved portal URL still points at ${STALE_HOST}: ${portalUrl}`);
  }
  log(`canonical payment-methods URL → ${portalUrl}`);

  // ---- 1. workspaces.portal_config.general.payment_update_url ----
  const { data: ws, error: wsErr } = await admin
    .from("workspaces").select("portal_config").eq("id", WORKSPACE_ID).single();
  if (wsErr) throw new Error(`workspace read failed: ${wsErr.message}`);
  const config = (ws?.portal_config as Record<string, unknown>) || {};
  const general = (config.general as Record<string, unknown>) || {};
  const currentUrl = String(general.payment_update_url ?? "");

  if (currentUrl === portalUrl) {
    log("portal_config.general.payment_update_url already canonical — skipping");
  } else {
    log(`portal_config.general.payment_update_url: "${currentUrl}" → "${portalUrl}"`);
    if (APPLY) {
      const merged = { ...config, general: { ...general, payment_update_url: portalUrl } };
      const { error } = await admin
        .from("workspaces").update({ portal_config: merged }).eq("id", WORKSPACE_ID);
      if (error) throw new Error(`portal_config write failed: ${error.message}`);
      log("portal_config updated");
    }
  }

  // ---- 2. the sonnet_prompts knowledge entry ----
  const { data: prompts, error: pErr } = await admin
    .from("sonnet_prompts")
    .select("id, title, content, status, enabled, category, sort_order")
    .eq("workspace_id", WORKSPACE_ID)
    .eq("title", PROMPT_TITLE)
    .neq("status", "archived");
  if (pErr) throw new Error(`sonnet_prompts read failed: ${pErr.message}`);

  const stale = (prompts || []).filter((r) => String(r.content ?? "").includes(STALE_HOST));
  if (!stale.length) {
    log("no live sonnet_prompts row still quoting the Shopify account page — skipping");
  } else {
    const newContent = [
      "PAYMENT METHOD UPDATE:",
      "When a customer asks how to update, add, or remove a payment method:",
      "",
      `Direct them to: ${portalUrl}`,
      "",
      "Instructions: Sign in there and the saved cards are listed on that page. Add adds a new card; Remove takes a saved card off the account.",
      "",
      "Never send a customer to a Shopify account page for anything card-related. We cannot add, remove, or reorder cards in Shopify's vault, so those steps do not work — this is what ticket c969f235 hit.",
      "",
      "A card that is paying for an active subscription cannot be removed until that subscription is switched to another card. Say that plainly rather than repeating the removal steps.",
      "",
      'Do NOT give vague instructions like "look for a Payment Method section." Always give the exact URL.',
    ].join("\n");

    for (const old of stale) {
      log(`superseding sonnet_prompts ${old.id} (status=${old.status}, enabled=${old.enabled})`);
      if (!APPLY) continue;

      const { id: newId, error: proposeErr } = await proposePrompt(admin, {
        workspaceId: WORKSPACE_ID,
        title: PROMPT_TITLE,
        content: newContent,
        category: String(old.category ?? "knowledge"),
        derivedFromTicketId: TICKET_ID,
        sortOrder: Number(old.sort_order ?? 0),
      });
      if (proposeErr || !newId) throw new Error(`proposePrompt failed: ${proposeErr}`);

      const accepted = await applyManualOverride(admin, {
        workspaceId: WORKSPACE_ID,
        promptId: newId,
        action: "accept",
        actor: ACTOR,
        reasonPrefix: `[manual_override:accept] ticket ${TICKET_ID} — retire the Shopify account-page URL in favour of ${portalUrl}`,
      });
      if (!accepted.ok) throw new Error(`applyManualOverride failed: ${accepted.error}`);

      const archived = await archiveSupersededPrompt(admin, {
        workspaceId: WORKSPACE_ID,
        oldPromptId: old.id as string,
        newPromptId: newId,
      });
      if (!archived.ok) throw new Error(`archiveSupersededPrompt failed: ${archived.error}`);
      log(`  → new prompt ${newId} approved+enabled; ${old.id} archived`);
    }
  }

  log("done");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
