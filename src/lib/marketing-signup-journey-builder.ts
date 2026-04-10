/**
 * Marketing Signup Journey Builder — single source of truth.
 * Checks email/SMS subscription status, offers consent + phone collection.
 */

import { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

interface JourneyStep {
  key: string;
  type: "checklist" | "confirm" | "text" | "select" | "single_choice" | "phone" | "info" | "item_accounting" | "address_form";
  question: string;
  subtitle?: string;
  placeholder?: string;
  options?: { value: string; label: string }[];
  isTerminal?: boolean;
}

interface BuiltResult {
  codeDriven: boolean;
  multiStep: boolean;
  steps: JourneyStep[];
}

export async function buildMarketingSignupSteps(
  admin: Admin, workspaceId: string, customerId: string, _ticketId: string,
): Promise<BuiltResult> {
  const { data: customer } = await admin.from("customers")
    .select("email, phone, email_marketing_status, sms_marketing_status, shopify_customer_id")
    .eq("id", customerId).single();

  if (!customer) return { codeDriven: true, multiStep: false, steps: [] };

  const emailSubscribed = customer.email_marketing_status === "subscribed";
  const smsSubscribed = customer.sms_marketing_status === "subscribed";

  // Already subscribed to both
  if (emailSubscribed && smsSubscribed) {
    // Check for available coupons
    const { data: coupons } = await admin.from("coupon_mappings")
      .select("code, summary").eq("workspace_id", workspaceId).eq("ai_enabled", true).limit(1);

    if (coupons?.length) {
      return { codeDriven: true, multiStep: false, steps: [{
        key: "already_subscribed",
        type: "info",
        question: `You're already subscribed! Use code ${coupons[0].code} for ${coupons[0].summary}.`,
        isTerminal: true,
      }] };
    }
    return { codeDriven: true, multiStep: false, steps: [{
      key: "already_subscribed",
      type: "info",
      question: "You're already subscribed to our emails and SMS. You'll be the first to know about our deals!",
      isTerminal: true,
    }] };
  }

  const steps: JourneyStep[] = [];

  // Consent step
  steps.push({
    key: "consent",
    type: "confirm",
    question: "Sign up for exclusive coupons and deals?",
    subtitle: emailSubscribed
      ? "Add SMS to get instant notifications about new deals."
      : smsSubscribed
        ? "Add email to get detailed offers and announcements."
        : "Subscribe to email and SMS for the best deals.",
    options: [
      { value: "yes", label: "Yes, sign me up!" },
      { value: "no", label: "No thanks" },
    ],
  });

  // Phone number step (if no phone on file and not SMS subscribed)
  if (!smsSubscribed && !customer.phone) {
    steps.push({
      key: "phone",
      type: "phone",
      question: "What's your phone number for SMS deals?",
      placeholder: "(555) 555-5555",
    });
  }

  return { codeDriven: true, multiStep: true, steps };
}
