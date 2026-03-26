export type TicketChannel = "email" | "chat" | "meta_dm" | "sms";
export type TicketStatus = "open" | "pending" | "closed";
export type MessageDirection = "inbound" | "outbound";
export type MessageVisibility = "external" | "internal";
export type MessageAuthorType = "customer" | "agent" | "ai" | "system";

export interface Ticket {
  id: string;
  workspace_id: string;
  customer_id: string | null;
  channel: TicketChannel;
  status: TicketStatus;
  subject: string | null;
  ai_confidence: number | null;
  ai_handled: boolean;
  ai_draft: string | null;
  ai_tier: string | null;
  ai_source_type: string | null;
  ai_source_id: string | null;
  ai_suggested_macro_id: string | null;
  ai_suggested_macro_name: string | null;
  assigned_to: string | null;
  escalated_to: string | null;
  escalated_at: string | null;
  escalation_reason: string | null;
  auto_reply_at: string | null;
  pending_auto_reply: string | null;
  last_customer_reply_at: string | null;
  first_response_at: string | null;
  resolved_at: string | null;
  csat_score: number | null;
  tags: string[];
  email_message_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface TicketMessage {
  id: string;
  ticket_id: string;
  direction: MessageDirection;
  visibility: MessageVisibility;
  author_type: MessageAuthorType;
  author_id: string | null;
  body: string;
  email_message_id: string | null;
  ai_draft: boolean;
  created_at: string;
  // Joined
  author_name?: string;
  author_email?: string;
}

export interface TicketWithCustomer extends Ticket {
  customer_email?: string;
  customer_name?: string;
  assigned_name?: string;
}
