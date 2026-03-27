// Multi-turn AI turn router
// Decides what happens when a customer replies to an AI-handled ticket

import { createAdminClient } from "@/lib/supabase/admin";

export interface TurnDecision {
  action: "ai_continue" | "ai_draft_review" | "escalate" | "close_check";
  reason: string;
  newTag?: string;
}

// Immediate escalation keyword lists
const CANCEL_KEYWORDS = ["cancel", "cancellation", "want to cancel", "cancel my subscription", "cancel my order", "stop my subscription"];
const BILLING_KEYWORDS = ["refund", "chargeback", "dispute", "fraud", "lawyer", "bbb", "attorney", "sue", "legal"];
const HUMAN_KEYWORDS = ["speak to someone", "talk to a person", "human", "real person", "agent please", "talk to human", "speak to a human", "real agent", "supervisor", "manager"];

// Negative sentiment signals
const NEGATIVE_SIGNALS = ["still", "again", "already told", "not helpful", "doesn't work", "wrong", "still wrong", "frustrated", "ridiculous", "unacceptable", "worst", "terrible", "never again", "useless", "incompetent", "waste of time"];

// Short positive replies (for close check)
const POSITIVE_PHRASES = ["thanks", "thank you", "got it", "great", "perfect", "awesome", "wonderful", "appreciate", "that helps", "that worked", "all good", "sorted", "resolved"];

export async function routeInboundReply(
  ticketId: string,
  messageBody: string,
): Promise<TurnDecision> {
  const admin = createAdminClient();

  const { data: ticket } = await admin
    .from("tickets")
    .select("ai_turn_count, ai_turn_limit, tags, channel")
    .eq("id", ticketId)
    .single();

  if (!ticket) return { action: "escalate", reason: "ticket_not_found" };

  const bodyLower = messageBody.toLowerCase().replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const words = bodyLower.split(/\s+/);

  // 1. IMMEDIATE ESCALATION CHECKS

  // Cancellation intent
  for (const kw of CANCEL_KEYWORDS) {
    if (bodyLower.includes(kw)) {
      return { action: "escalate", reason: "cancellation_intent" };
    }
  }

  // Billing dispute / legal threat
  for (const kw of BILLING_KEYWORDS) {
    if (bodyLower.includes(kw)) {
      return { action: "escalate", reason: "billing_dispute" };
    }
  }

  // Human requested
  for (const kw of HUMAN_KEYWORDS) {
    if (bodyLower.includes(kw)) {
      return { action: "escalate", reason: "human_requested" };
    }
  }

  // Turn limit reached
  if (ticket.ai_turn_count >= ticket.ai_turn_limit) {
    return { action: "escalate", reason: "turn_limit_reached" };
  }

  // Social comments: always 1 turn max
  if (ticket.channel === "social_comments" && ticket.ai_turn_count >= 1) {
    return { action: "escalate", reason: "turn_limit_reached" };
  }

  // 2. POSITIVE CLOSURE CHECK
  if (words.length < 50) {
    const positiveCount = POSITIVE_PHRASES.filter(p => bodyLower.includes(p)).length;
    if (positiveCount > 0 && words.length < 20) {
      return { action: "close_check", reason: "positive_closure_detected" };
    }
  }

  // 3. NEGATIVE SENTIMENT CHECK
  const negativeCount = NEGATIVE_SIGNALS.filter(s => bodyLower.includes(s)).length;
  if (negativeCount >= 2) {
    return { action: "ai_draft_review", reason: "negative_sentiment_detected" };
  }

  // 4. DEFAULT: AI continues
  return { action: "ai_continue", reason: "normal_reply" };
}
