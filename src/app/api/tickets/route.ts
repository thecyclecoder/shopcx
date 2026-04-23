import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";

// GET: list tickets with filters
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const channel = searchParams.get("channel");
  const assignedTo = searchParams.get("assigned_to");
  const tag = searchParams.get("tag");
  const escalated = searchParams.get("escalated");
  const snoozed = searchParams.get("snoozed");
  const search = searchParams.get("search");
  const sort = searchParams.get("sort") || "updated_at";
  const order = searchParams.get("order") || "desc";
  const limit = Math.min(parseInt(searchParams.get("limit") || "25"), 100);
  const offset = parseInt(searchParams.get("offset") || "0");

  const admin = createAdminClient();

  let query = admin
    .from("tickets")
    .select(
      "*, customers(email, first_name, last_name)",
      { count: "exact" }
    )
    .eq("workspace_id", workspaceId);

  if (status === "archived") {
    query = query.eq("status", "archived");
  } else if (status && status !== "all") {
    query = query.eq("status", status);
  } else {
    // Default: exclude archived tickets
    query = query.neq("status", "archived");
  }
  if (channel && channel !== "all") query = query.eq("channel", channel);
  if (assignedTo === "__ai_agent") {
    query = query.eq("ai_handled", true).is("assigned_to", null);
  } else if (assignedTo === "__workflow") {
    // Workflow-handled tickets no longer tracked via handled_by; filter by tag instead
    query = query.contains("tags", ["touched"]).filter("tags", "cs", "{w:}");
  } else if (assignedTo) {
    query = query.eq("assigned_to", assignedTo);
  }
  if (tag) {
    const tagList = tag.split(",").map(t => t.trim()).filter(Boolean);
    if (tagList.length === 1) {
      query = query.contains("tags", tagList);
    } else if (tagList.length > 1) {
      // Ticket must have ALL selected tags
      query = query.contains("tags", tagList);
    }
  }
  if (escalated === "true") query = query.not("escalated_to", "is", null);
  if (snoozed === "true") {
    query = query.gt("snoozed_until", new Date().toISOString());
  } else if (snoozed !== "all") {
    // Default: exclude snoozed tickets
    query = query.or("snoozed_until.is.null,snoozed_until.lte." + new Date().toISOString());
  }
  const escalationMine = searchParams.get("escalation_mine");
  if (escalationMine === "true" && user) {
    // Tickets escalated TO me or tickets I assigned that were escalated
    query = query.not("escalated_to", "is", null).or(`escalated_to.eq.${user.id},assigned_to.eq.${user.id}`);
  }
  if (search) {
    // Search by subject OR customer name/email
    const { data: matchingCustomers } = await admin.from("customers")
      .select("id")
      .eq("workspace_id", workspaceId)
      .or(`email.ilike.%${search}%,first_name.ilike.%${search}%,last_name.ilike.%${search}%`)
      .limit(50);
    const custIds = (matchingCustomers || []).map(c => c.id);
    if (custIds.length > 0) {
      query = query.or(`subject.ilike.%${search}%,customer_id.in.(${custIds.join(",")})`);
    } else {
      query = query.ilike("subject", `%${search}%`);
    }
  }

  const ascending = order === "asc";
  query = query
    .order(sort, { ascending })
    .range(offset, offset + limit - 1);

  const { data: tickets, count, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Enrich with assigned user names
  const assignedIds = [...new Set(tickets?.filter((t) => t.assigned_to).map((t) => t.assigned_to))];
  let assignedMap = new Map<string, string>();

  if (assignedIds.length > 0) {
    const { data: usersData } = await admin.auth.admin.listUsers();
    assignedMap = new Map(
      usersData?.users
        ?.filter((u) => assignedIds.includes(u.id))
        .map((u) => [u.id, u.user_metadata?.full_name || u.user_metadata?.name || u.email || ""])
      ?? []
    );
  }

  const enriched = tickets?.map((t) => ({
    ...t,
    customer_email: t.customers?.email,
    customer_name: [t.customers?.first_name, t.customers?.last_name].filter(Boolean).join(" ") || null,
    assigned_name: t.assigned_to ? assignedMap.get(t.assigned_to) || null : null,
    snoozed_until: t.snoozed_until || null,
    customers: undefined,
  }));

  return NextResponse.json({
    tickets: enriched,
    total: count || 0,
    limit,
    offset,
  });
}

// POST: create a new ticket
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const body = await request.json();
  const { customer_id, customer_email, channel, subject, message } = body;

  if (!subject || !message) {
    return NextResponse.json({ error: "Subject and message are required" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Resolve customer
  let resolvedCustomerId = customer_id;
  if (!resolvedCustomerId && customer_email) {
    const { data: existing } = await admin
      .from("customers")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("email", customer_email.toLowerCase())
      .single();

    if (existing) {
      resolvedCustomerId = existing.id;
    } else {
      const { data: created } = await admin
        .from("customers")
        .insert({
          workspace_id: workspaceId,
          email: customer_email.toLowerCase(),
        })
        .select("id")
        .single();
      resolvedCustomerId = created?.id;
    }
  }

  // Create ticket
  const { data: ticket, error: ticketError } = await admin
    .from("tickets")
    .insert({
      workspace_id: workspaceId,
      customer_id: resolvedCustomerId || null,
      channel: channel || "email",
      status: "open",
      subject,
    })
    .select()
    .single();

  if (ticketError || !ticket) {
    return NextResponse.json({ error: "Failed to create ticket" }, { status: 500 });
  }

  // Create initial message
  await admin.from("ticket_messages").insert({
    ticket_id: ticket.id,
    direction: "inbound",
    visibility: "external",
    author_type: "customer",
    body: message,
  });

  return NextResponse.json(ticket, { status: 201 });
}
