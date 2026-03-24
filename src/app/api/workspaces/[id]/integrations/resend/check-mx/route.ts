import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { promises as dns } from "dns";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: workspace } = await admin
    .from("workspaces")
    .select("resend_domain")
    .eq("id", workspaceId)
    .single();

  if (!workspace?.resend_domain) {
    return NextResponse.json({ error: "Resend domain not configured" }, { status: 400 });
  }

  const domain = workspace.resend_domain;
  const results: { domain: string; has_mx: boolean; mx_records: string[]; can_receive: boolean }[] = [];

  // Check the domain itself and common subdomains
  const domainsToCheck = [
    domain,
    `send.${domain}`,
    `mail.${domain}`,
    `inbound.${domain}`,
  ];

  // Also check parent domain if this is already a subdomain
  const parts = domain.split(".");
  if (parts.length > 2) {
    const parent = parts.slice(1).join(".");
    domainsToCheck.push(parent);
  }

  for (const d of domainsToCheck) {
    try {
      const mxRecords = await dns.resolveMx(d);
      const sorted = mxRecords.sort((a, b) => a.priority - b.priority);
      const hasResendInbound = sorted.some((r) =>
        r.exchange.toLowerCase().includes("resend") ||
        r.exchange.toLowerCase().includes("inbound-smtp")
      );

      results.push({
        domain: d,
        has_mx: sorted.length > 0,
        mx_records: sorted.map((r) => `${r.priority} ${r.exchange}`),
        can_receive: hasResendInbound,
      });
    } catch {
      results.push({
        domain: d,
        has_mx: false,
        mx_records: [],
        can_receive: false,
      });
    }
  }

  // Find the best inbound domain (one with Resend MX)
  const resendReady = results.find((r) => r.can_receive);

  return NextResponse.json({
    configured_domain: domain,
    checks: results,
    inbound_ready: resendReady?.domain || null,
    inbound_address: resendReady ? `inbound@${resendReady.domain}` : null,
    setup_needed: !resendReady,
    setup_instructions: !resendReady
      ? `Add an MX record to ${domain}: Type=MX, Name=${domain}, Content=inbound-smtp.resend.com, Priority=10`
      : null,
  });
}
