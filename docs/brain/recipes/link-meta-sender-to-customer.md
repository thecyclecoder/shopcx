# Link a Meta sender to a customer

Bridge a `meta_sender_id` (opaque Meta identifier) to one of our [[../tables/customers]] rows so future DMs / comments from that sender resolve their full account context.

## Pattern

```ts
import { createAdminClient } from "@/lib/supabase/admin";

const admin = createAdminClient();

await admin.from("meta_sender_customer_links").upsert(
  {
    workspace_id: workspaceId,
    meta_sender_id: senderId,
    customer_id: customerId,
    matched_via: "agent_confirmed",   // or "email_provided", "fuzzy_name_match"
    confidence: 1.0,                  // 0..1
  },
  { onConflict: "workspace_id,meta_sender_id" }
);
```

That's the entire write — the next inbound DM / comment from `senderId` will match.

## Finding the right customer

For DMs where the sender hasn't given an email, use the fuzzy-match helper:

```ts
import { findCustomerCandidatesByMetaName } from "@/lib/social-comment-customer-match";

const candidates = await findCustomerCandidatesByMetaName({
  workspaceId,
  metaSenderName: comment.sender_name,
});

if (candidates.length === 1 && candidates[0].confidence > 0.85) {
  // Auto-link
  await admin.from("meta_sender_customer_links").upsert({...});
} else {
  // Ask the customer for their order email via the orchestrator
}
```

See [[../libraries/social-comment-customer-match]] for the full candidate-finding logic.

## When the customer gives an email

The orchestrator asks "What email did you use when ordering?" → customer replies. Match the email:

```ts
const { data: matched } = await admin
  .from("customers")
  .select("id")
  .eq("workspace_id", workspaceId)
  .ilike("email", customerProvidedEmail)
  .maybeSingle();

if (matched) {
  await admin.from("meta_sender_customer_links").upsert(
    {
      workspace_id: workspaceId,
      meta_sender_id: senderId,
      customer_id: matched.id,
      matched_via: "email_provided",
      confidence: 1.0,
    },
    { onConflict: "workspace_id,meta_sender_id" }
  );
}
```

## Gotchas

- **Upsert with `onConflict: "workspace_id,meta_sender_id"`** — never insert blindly.
- **`confidence` matters.** Fuzzy matches < 0.85 should be agent-confirmed, not auto-linked.
- **For linked accounts**, only ONE meta_sender_id should map to one customer at a time. If the customer's linked group changes, the existing sender link doesn't need to move — the group membership is queried at lookup time.
- **Banned users**: don't link a [[../tables/banned_meta_users]] sender to a customer. The orchestrator's fraud gate would short-circuit the conversation anyway, but the link itself is misleading.
- **No customer-driven update** — only orchestrator / agent UI should write this table.

## Related

[[../libraries/social-comment-customer-match]] · [[ban-meta-user]] · [[hide-comment]] · [[../tables/meta_sender_customer_links]] · [[../lifecycles/social-comment-moderation]] · [[../lifecycles/customer-link-confirmation]]
