// Default cancellation journey config — seeded for new workspaces

export const DEFAULT_REMEDIES = [
  { name: "Coupon Discount", type: "coupon", config: {}, description: "Apply a coupon to their subscription", priority: 1 },
  { name: "Pause 30 Days", type: "pause", config: { days: [30] }, description: "Pause subscription for 30 days", priority: 2 },
  { name: "Pause 60 Days", type: "pause", config: { days: [60] }, description: "Pause subscription for 60 days", priority: 3 },
  { name: "Skip Next Order", type: "skip", config: {}, description: "Skip the next scheduled order (manual — Appstle skip disabled)", priority: 4 },
  { name: "Monthly Frequency", type: "frequency_change", config: { options: ["MONTH/1"] }, description: "Switch to monthly deliveries", priority: 5 },
  { name: "Every Other Month", type: "frequency_change", config: { options: ["MONTH/2"] }, description: "Switch to every-other-month deliveries", priority: 6 },
  { name: "AI Conversation", type: "ai_conversation", config: { max_turns: 3 }, description: "Empathetic AI conversation for open-ended reasons", priority: 7 },
  { name: "Social Proof", type: "social_proof", config: {}, description: "Show relevant product reviews", priority: 8 },
  { name: "Connect with Specialist", type: "specialist", config: {}, description: "Route to a product specialist for personalized help", priority: 9 },
];

export const CANCELLATION_JOURNEY_CONFIG = {
  steps: [
    {
      key: "cancellation_reason",
      type: "single_choice",
      question: "We're sorry to see you go. Help us understand why?",
      subtitle: "Your feedback helps us improve.",
      options: [
        { value: "too_expensive", label: "It's too expensive", emoji: "💸", rebuttalStepKey: "rebuttal_price" },
        { value: "too_much_product", label: "I have too much product", emoji: "📦", rebuttalStepKey: "rebuttal_quantity" },
        { value: "not_seeing_results", label: "I'm not seeing results", emoji: "😕", rebuttalStepKey: "rebuttal_results" },
        { value: "taste_texture", label: "I don't like the taste or texture", emoji: "😬", rebuttalStepKey: "rebuttal_swap" },
        { value: "health_change", label: "My health needs have changed", emoji: "🏥", rebuttalStepKey: "rebuttal_swap" },
        { value: "just_pausing", label: "I just need a break", emoji: "⏸️", rebuttalStepKey: "rebuttal_pause" },
        { value: "other", label: "Something else", emoji: "💬", nextStepKey: "confirm_cancel" },
      ],
    },
    {
      key: "rebuttal_price",
      type: "single_choice",
      question: "We'd love to keep you. How about one of these?",
      options: [
        { value: "accept_discount", label: "Get 20% off for 3 months", emoji: "🎉", nextStepKey: "journey_end", outcome: "saved_discount" },
        { value: "accept_pause", label: "Pause my subscription for 60 days", emoji: "⏸️", nextStepKey: "journey_end", outcome: "saved_pause" },
        { value: "proceed_cancel", label: "I still want to cancel", nextStepKey: "confirm_cancel" },
      ],
    },
    {
      key: "rebuttal_quantity",
      type: "single_choice",
      question: "No problem — we can adjust things for you.",
      options: [
        { value: "accept_skip", label: "Skip my next order", nextStepKey: "journey_end", outcome: "saved_skip" },
        { value: "accept_frequency", label: "Switch to every 2 months", nextStepKey: "journey_end", outcome: "saved_frequency" },
        { value: "proceed_cancel", label: "I still want to cancel", nextStepKey: "confirm_cancel" },
      ],
    },
    {
      key: "rebuttal_results",
      type: "single_choice",
      question: "Results take time — and we want to help.",
      options: [
        { value: "accept_coach", label: "Connect me with a product specialist", nextStepKey: "journey_end", outcome: "saved_coach" },
        { value: "accept_pause", label: "Pause for 30 days and try again", nextStepKey: "journey_end", outcome: "saved_pause_short" },
        { value: "proceed_cancel", label: "I still want to cancel", nextStepKey: "confirm_cancel" },
      ],
    },
    {
      key: "rebuttal_swap",
      type: "single_choice",
      question: "We have other products you might love.",
      options: [
        { value: "accept_swap", label: "Let me try a different product", nextStepKey: "journey_end", outcome: "saved_swap" },
        { value: "proceed_cancel", label: "I still want to cancel", nextStepKey: "confirm_cancel" },
      ],
    },
    {
      key: "rebuttal_pause",
      type: "single_choice",
      question: "No problem — you don't have to cancel.",
      options: [
        { value: "accept_pause_60", label: "Pause for 60 days", nextStepKey: "journey_end", outcome: "saved_pause" },
        { value: "accept_pause_90", label: "Pause for 90 days", nextStepKey: "journey_end", outcome: "saved_pause_long" },
        { value: "proceed_cancel", label: "I'd rather cancel", nextStepKey: "confirm_cancel" },
      ],
    },
    {
      key: "confirm_cancel",
      type: "confirmation",
      question: "Are you sure you want to cancel?",
      subtitle: "This will cancel your subscription at the end of your current billing period. You won't be charged again.",
      options: [
        { value: "confirm", label: "Yes, cancel my subscription", outcome: "cancelled" },
        { value: "go_back", label: "Actually, keep my subscription", outcome: "saved_changed_mind" },
      ],
    },
    {
      key: "journey_end",
      type: "terminal" as const,
      question: "",
      isTerminal: true,
    },
  ],
  outcomes: [
    { key: "cancelled", action: { type: "cancel_subscription", params: { at_period_end: true } }, label: "Cancelled" },
    { key: "saved_discount", action: { type: "apply_discount", params: { percent: 20, duration_months: 3 } }, label: "Saved — Discount" },
    { key: "saved_pause", action: { type: "pause_subscription", params: { weeks: 8 } }, label: "Saved — Pause 60d" },
    { key: "saved_pause_short", action: { type: "pause_subscription", params: { weeks: 4 } }, label: "Saved — Pause 30d" },
    { key: "saved_pause_long", action: { type: "pause_subscription", params: { weeks: 12 } }, label: "Saved — Pause 90d" },
    { key: "saved_skip", action: { type: "skip_order", params: {} }, label: "Saved — Skip Order" },
    { key: "saved_frequency", action: { type: "update_frequency", params: { interval: "2_months" } }, label: "Saved — Frequency" },
    { key: "saved_coach", action: { type: "assign_agent", params: {} }, label: "Saved — Coach" },
    { key: "saved_swap", action: { type: "assign_agent", params: {} }, label: "Saved — Product Swap" },
    { key: "saved_changed_mind", action: { type: "close_ticket", params: {} }, label: "Saved — Changed Mind" },
  ],
  branding: {
    primaryColor: "#4f46e5",
    accentColor: "#06b6d4",
  },
  messages: {
    intro: "We want to make sure we get this right for you.",
    completedSave: "Great news! We've updated your subscription. Thank you for staying with us! 💚",
    completedCancel: "Your subscription has been cancelled. You won't be charged again. We're sorry to see you go — you're always welcome back!",
    completedDefault: "Thank you! We've processed your request.",
  },
};
