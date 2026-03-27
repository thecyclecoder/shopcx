import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";

interface BulkActionBody {
  ticket_ids: string[];
  action: "close" | "assign" | "add_tag" | "remove_tag" | "set_status" | "delete";
  value?: string;
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const body: BulkActionBody = await request.json();
  const { ticket_ids, action, value } = body;

  if (!Array.isArray(ticket_ids) || ticket_ids.length === 0) {
    return NextResponse.json({ error: "No ticket IDs provided" }, { status: 400 });
  }
  if (ticket_ids.length > 100) {
    return NextResponse.json({ error: "Maximum 100 tickets per request" }, { status: 400 });
  }

  const admin = createAdminClient();
  const errors: string[] = [];
  let updated = 0;

  // For delete action, require admin/owner role
  if (action === "delete") {
    const { data: member } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspaceId)
      .eq("user_id", user.id)
      .single();

    if (!member || !["owner", "admin"].includes(member.role)) {
      return NextResponse.json({ error: "Only owner or admin can delete tickets" }, { status: 403 });
    }
  }

  try {
    switch (action) {
      case "close": {
        const { count, error } = await admin
          .from("tickets")
          .update({ status: "closed", resolved_at: new Date().toISOString() }, { count: "exact" })
          .in("id", ticket_ids)
          .eq("workspace_id", workspaceId);
        if (error) errors.push(error.message);
        else updated = count ?? 0;
        break;
      }

      case "assign": {
        if (!value) {
          return NextResponse.json({ error: "Assignee value required" }, { status: 400 });
        }
        const { count, error } = await admin
          .from("tickets")
          .update({ assigned_to: value }, { count: "exact" })
          .in("id", ticket_ids)
          .eq("workspace_id", workspaceId);
        if (error) errors.push(error.message);
        else updated = count ?? 0;
        break;
      }

      case "set_status": {
        if (!value || !["open", "pending", "closed"].includes(value)) {
          return NextResponse.json({ error: "Valid status required" }, { status: 400 });
        }
        const updateData: Record<string, string> = { status: value };
        if (value === "closed") updateData.resolved_at = new Date().toISOString();
        const { count, error } = await admin
          .from("tickets")
          .update(updateData, { count: "exact" })
          .in("id", ticket_ids)
          .eq("workspace_id", workspaceId);
        if (error) errors.push(error.message);
        else updated = count ?? 0;
        break;
      }

      case "add_tag": {
        if (!value) {
          return NextResponse.json({ error: "Tag value required" }, { status: 400 });
        }
        // Fetch tickets to get current tags, then update each
        const { data: tickets } = await admin
          .from("tickets")
          .select("id, tags")
          .in("id", ticket_ids)
          .eq("workspace_id", workspaceId);

        for (const ticket of tickets ?? []) {
          const currentTags: string[] = ticket.tags || [];
          if (!currentTags.includes(value)) {
            const { error } = await admin
              .from("tickets")
              .update({ tags: [...currentTags, value] })
              .eq("id", ticket.id);
            if (error) errors.push(`Ticket ${ticket.id}: ${error.message}`);
            else updated++;
          } else {
            updated++; // Already has tag, count as success
          }
        }
        break;
      }

      case "remove_tag": {
        if (!value) {
          return NextResponse.json({ error: "Tag value required" }, { status: 400 });
        }
        const { data: tickets } = await admin
          .from("tickets")
          .select("id, tags")
          .in("id", ticket_ids)
          .eq("workspace_id", workspaceId);

        for (const ticket of tickets ?? []) {
          const currentTags: string[] = ticket.tags || [];
          if (currentTags.includes(value)) {
            const { error } = await admin
              .from("tickets")
              .update({ tags: currentTags.filter(t => t !== value) })
              .eq("id", ticket.id);
            if (error) errors.push(`Ticket ${ticket.id}: ${error.message}`);
            else updated++;
          } else {
            updated++;
          }
        }
        break;
      }

      case "delete": {
        // Delete messages first, then tickets
        for (const ticketId of ticket_ids) {
          const { error: msgErr } = await admin
            .from("ticket_messages")
            .delete()
            .eq("ticket_id", ticketId);
          if (msgErr) {
            errors.push(`Messages for ${ticketId}: ${msgErr.message}`);
            continue;
          }
          const { error: ticketErr } = await admin
            .from("tickets")
            .delete()
            .eq("id", ticketId)
            .eq("workspace_id", workspaceId);
          if (ticketErr) errors.push(`Ticket ${ticketId}: ${ticketErr.message}`);
          else updated++;
        }
        break;
      }

      default:
        return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }
  } catch (err) {
    errors.push(String(err));
  }

  return NextResponse.json({ updated, errors });
}
