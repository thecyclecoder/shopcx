/**
 * Determines the effective delivery channel for a ticket.
 *
 * For chat tickets: if the customer has been idle for more than IDLE_THRESHOLD,
 * returns "email" so responses reach them via their inbox instead of a chat
 * window they've already left.
 *
 * For all other channels, returns the ticket's original channel unchanged.
 */

import { createAdminClient } from "@/lib/supabase/admin";

const IDLE_THRESHOLD_MS = 3 * 60 * 1000; // 3 minutes

export async function getDeliveryChannel(
  ticketId: string,
  ticketChannel: string,
): Promise<string> {
  if (ticketChannel !== "chat") return ticketChannel;

  const admin = createAdminClient();

  const { data: lastInbound } = await admin
    .from("ticket_messages")
    .select("created_at")
    .eq("ticket_id", ticketId)
    .eq("direction", "inbound")
    .eq("author_type", "customer")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!lastInbound) return ticketChannel;

  const lastActivity = new Date(lastInbound.created_at).getTime();
  const isIdle = Date.now() - lastActivity > IDLE_THRESHOLD_MS;

  return isIdle ? "email" : "chat";
}
