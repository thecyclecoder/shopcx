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

  // Already opted into at least one channel → hand over the coupon
  // immediately. They've already given us marketing consent, so making
  // them fill out a second consent form before delivering the discount
  // they asked for is unnecessary friction. Surfaced on ticket
  // e2e7c41d (Erin, May 5) — email-subscribed but not SMS, got the
  // consent gate, said "Thank you!" without clicking, never got the
  // coupon she explicitly asked for.
  if (emailSubscribed || smsSubscribed) {
    const coupon = await pickDiscountRequestCoupon(admin, workspaceId);
    if (coupon) {
      const upgradeNote = emailSubscribed && !smsSubscribed
        ? " (Want SMS deal alerts too? Just reply YES.)"
        : !emailSubscribed && smsSubscribed
          ? " (Want email deals too? Reply with your email.)"
          : "";
      return { codeDriven: true, multiStep: false, steps: [{
        key: "already_subscribed",
        type: "info",
        question: `You're all set — use code ${coupon.code} for ${coupon.summary}.${upgradeNote}`,
        isTerminal: true,
      }] };
    }
    return { codeDriven: true, multiStep: false, steps: [{
      key: "already_subscribed",
      type: "info",
      question: "You're already subscribed. You'll be the first to know about our deals!",
      isTerminal: true,
    }] };
  }

  const steps: JourneyStep[] = [];

  // Consent step — only for customers NOT yet on any list
  steps.push({
    key: "consent",
    type: "confirm",
    question: "Sign up for exclusive coupons and deals?",
    subtitle: "Subscribe to email and SMS for the best deals.",
    options: [
      { value: "yes", label: "Yes, sign me up!" },
      { value: "no", label: "No thanks" },
    ],
  });

  // Phone number step (if no phone on file)
  if (!customer.phone) {
    steps.push({
      key: "phone",
      type: "phone",
      question: "What's your phone number for SMS deals?",
      placeholder: "(555) 555-5555",
    });
  }

  return { codeDriven: true, multiStep: true, steps };
}

/**
 * Pick the coupon that fits a discount_request (not a cancel-prevention
 * coupon). Falls back to any ai_enabled coupon if no discount_request
 * match exists.
 */
async function pickDiscountRequestCoupon(admin: Admin, workspaceId: string): Promise<{ code: string; summary: string } | null> {
  const { data: discountRequest } = await admin.from("coupon_mappings")
    .select("code, summary")
    .eq("workspace_id", workspaceId)
    .eq("ai_enabled", true)
    .contains("use_cases", ["discount_request"])
    .order("value", { ascending: true })  // smallest discount first — we hand out the lowest tier for unsolicited asks
    .limit(1).maybeSingle();
  if (discountRequest) return discountRequest;

  const { data: any1 } = await admin.from("coupon_mappings")
    .select("code, summary")
    .eq("workspace_id", workspaceId)
    .eq("ai_enabled", true)
    .limit(1).maybeSingle();
  return any1 || null;
}
