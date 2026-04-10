/**
 * Account Linking Journey Builder — single source of truth.
 * Finds unlinked customer profiles and builds a checklist + confirm flow.
 */

import { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

interface JourneyStep {
  key: string;
  type: "checklist" | "confirm" | "text" | "select" | "single_choice" | "phone" | "info" | "item_accounting" | "address_form";
  question: string;
  subtitle?: string;
  options?: { value: string; label: string }[];
  isTerminal?: boolean;
}

interface BuiltResult {
  codeDriven: boolean;
  multiStep: boolean;
  steps: JourneyStep[];
  metadata?: Record<string, unknown>;
}

export async function buildAccountLinkingSteps(
  admin: Admin, workspaceId: string, customerId: string, _ticketId: string,
): Promise<BuiltResult> {
  const { findUnlinkedMatches } = await import("@/lib/account-matching");
  const unlinked = await findUnlinkedMatches(workspaceId, customerId, admin);

  // Get existing group ID for metadata
  const { data: existingLinks } = await admin.from("customer_links")
    .select("group_id").eq("customer_id", customerId);
  const groupId = existingLinks?.[0]?.group_id || null;

  if (unlinked.length === 0) {
    return { codeDriven: true, multiStep: false, steps: [{
      key: "no_matches",
      type: "info",
      question: "Your account looks good — no additional profiles found!",
      isTerminal: true,
    }] };
  }

  return {
    codeDriven: true,
    multiStep: true,
    steps: [
      {
        key: "link_accounts",
        type: "checklist",
        question: "Select all email addresses that belong to you",
        subtitle: "We found these accounts that might be yours. Linking them helps us serve you better.",
        options: unlinked.map(m => ({ value: m.id, label: m.email })),
      },
      {
        key: "confirm_link",
        type: "confirm",
        question: "Confirm linking these accounts?",
        subtitle: "This will combine your order history and subscriptions into one profile.",
        options: [
          { value: "yes", label: "Yes, link them" },
          { value: "no", label: "No, these aren't mine" },
        ],
      },
    ],
    metadata: { unlinkedMatches: unlinked, existingGroupId: groupId },
  };
}
