import { createAdminClient } from "./_bootstrap";
import { launchJourneyForTicket } from "../src/lib/journey-delivery";

const WORKSPACE = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TICKET = "54f0f29e-d3f0-4f2e-9b85-114170dc075b";
const TICKET_CUSTOMER = "98f54a3e-a256-4b98-843a-d0e5a27c5a51";
const CANCEL_JOURNEY = "a75b1a8f-5fa9-448e-9fac-0656e9f25a95";

const leadIn =
  "Congratulations on losing 46 pounds — that is amazing, and we're so glad our products could be part of your journey. " +
  "I found your subscriptions and can help you wind down your Superfood Tabs and your Amazing Coffee and Creamer so you can move into maintenance.";
const ctaText = "Manage & cancel my subscriptions";

async function main() {
  const admin = createAdminClient();
  const apply = process.argv.includes("--apply");

  const { data: t } = await admin.from("tickets").select("channel").eq("id", TICKET).single();
  const channel = (t?.channel as string) || "email";
  console.log("channel:", channel);
  console.log("leadIn:", leadIn);
  console.log("cta:", ctaText);

  if (!apply) { console.log("\n(dry run — pass --apply to send)"); return; }

  const delivered = await launchJourneyForTicket({
    workspaceId: WORKSPACE,
    ticketId: TICKET,
    customerId: TICKET_CUSTOMER,
    journeyId: CANCEL_JOURNEY,
    journeyName: "Cancel Subscription",
    triggerIntent: "cancel_subscription",
    channel,
    leadIn,
    ctaText,
    prependAccountLinking: false,
  });
  console.log("\ndelivered:", delivered);

  const { data: sess } = await admin
    .from("journey_sessions")
    .select("id, token, journey_definition_id, subscription_id, created_at")
    .eq("ticket_id", TICKET)
    .order("created_at", { ascending: false })
    .limit(2);
  console.log("recent journey_sessions:", JSON.stringify(sess, null, 2));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
