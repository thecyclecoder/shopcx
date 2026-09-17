/**
 * Inngest: turn a Shopify-born subscription contract into a ShopCX subscription.
 *
 * ⭐ Why this is a delayed job and not inline in the webhook. We create contracts ourselves too —
 * the Appstle migration and the one-time-charge rail both call `subscriptionContractAtomicCreate`,
 * and Shopify fires `subscription_contracts/create` for those exactly as it does for a PDP
 * checkout. Each rail stamps its own claim marker milliseconds after the create, but the webhook
 * can and does arrive first. Ingesting inline would race: a migrated customer duplicated into a
 * second row, or a $1 one-time charge reborn as a recurring subscription.
 *
 * Sleeping first makes the claim check honest. It also lets `orders/create` land the customer row
 * for the same checkout, so ingestion joins to it instead of minting a duplicate customer.
 *
 * See [[docs/brain/inngest/shopcx-contract-ingest]] and
 * [[docs/brain/libraries/commerce__shopcx-contract-ingest]].
 */

import { inngest } from "./client";
import { enforceSwitch } from "@/lib/control-tower/enforce-switch";
import { emitReactiveHeartbeat } from "@/lib/control-tower/heartbeat";
import { ingestShopifyContract, syncShopifyContract } from "@/lib/commerce/shopcx-contract-ingest";

export const CONTRACT_CREATED_EVENT = "shopify/subscription-contract-created";
export const CONTRACT_UPDATED_EVENT = "shopify/subscription-contract-updated";
const INGEST_FN_ID = "shopcx-contract-ingest";
const SYNC_FN_ID = "shopcx-contract-sync";

/**
 * How long to wait for our own rails to stamp their claim markers.
 *
 * Both write theirs immediately after the create returns, so this is orders of magnitude more than
 * needed — the cost of waiting is a few minutes before a new subscriber appears in the portal, and
 * the cost of NOT waiting is a duplicated customer or a one-time charge that bills forever.
 */
const CLAIM_SETTLE = "3m";

export const shopcxContractIngest = inngest.createFunction(
  {
    id: INGEST_FN_ID,
    name: "ShopCX contract ingest — a PDP checkout becomes a subscription",
    retries: 3,
    concurrency: { limit: 4 },
    triggers: [{ event: CONTRACT_CREATED_EVENT }],
  },
  async ({ event, step }) => {
    const { workspaceId, contractId } = event.data as { workspaceId: string; contractId: string };

    await step.sleep("let-our-own-rails-claim-it", CLAIM_SETTLE);

    const gate = await step.run("check-kill-switch", () => enforceSwitch(INGEST_FN_ID));
    if (gate.ok === "blocked_off") {
      return { status: "skipped", reason: `switched_off_by:${gate.offBy}` };
    }

    const result = await step.run("ingest", () => ingestShopifyContract(workspaceId, contractId));

    if (!result.ingested) {
      console.log(`[shopcx-ingest] ${contractId}: not ingested — ${result.reason}`);
    } else {
      console.log(`[shopcx-ingest] ${contractId}: ingested as subscription ${result.subscriptionId}`);
    }

    await step.run("beat", () =>
      emitReactiveHeartbeat(INGEST_FN_ID, {
        produced: { outcome: result.ingested ? "ingested" : "skipped" },
      }),
    );
    return result;
  },
);

export const shopcxContractSync = inngest.createFunction(
  {
    id: SYNC_FN_ID,
    name: "ShopCX contract sync — mirror a Shopify-side contract edit",
    retries: 2,
    concurrency: { limit: 4 },
    triggers: [{ event: CONTRACT_UPDATED_EVENT }],
  },
  async ({ event, step }) => {
    const { workspaceId, contractId } = event.data as { workspaceId: string; contractId: string };

    // No sleep here. An update names a contract that already exists, so there is no create race to
    // wait out — and if no row exists yet, `syncShopifyContract` falls through to a full ingest
    // whose own claim check does the same job.
    const gate = await step.run("check-kill-switch", () => enforceSwitch(SYNC_FN_ID));
    if (gate.ok === "blocked_off") {
      return { status: "skipped", reason: `switched_off_by:${gate.offBy}` };
    }

    const result = await step.run("sync", () => syncShopifyContract(workspaceId, contractId));
    if (!result.ingested) console.log(`[shopcx-sync] ${contractId}: no-op — ${result.reason}`);

    await step.run("beat", () =>
      emitReactiveHeartbeat(SYNC_FN_ID, {
        produced: { outcome: result.ingested ? "synced" : "skipped" },
      }),
    );
    return result;
  },
);
