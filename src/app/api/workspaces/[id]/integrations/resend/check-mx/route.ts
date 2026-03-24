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
  const results: { domain: string; has_mx: boolean; mx_records: string[]; can_receive: boolean; google_dns_propagated: boolean }[] = [];

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

  // Also check via Google DNS (dig @8.8.8.8) using DNS-over-HTTPS
  async function checkMxGoogle(domain: string): Promise<{ has_mx: boolean; records: string[] }> {
    try {
      const res = await fetch(`https://dns.google/resolve?name=${domain}&type=MX`);
      const data = await res.json();
      if (!data.Answer?.length) return { has_mx: false, records: [] };
      const records = data.Answer
        .filter((a: { type: number }) => a.type === 15) // MX type
        .map((a: { data: string }) => a.data);
      return { has_mx: records.length > 0, records };
    } catch {
      return { has_mx: false, records: [] };
    }
  }

  for (const d of domainsToCheck) {
    try {
      const mxRecords = await dns.resolveMx(d);
      const sorted = mxRecords.sort((a, b) => a.priority - b.priority);
      const hasResendInbound = sorted.some((r) =>
        r.exchange.toLowerCase().includes("resend") ||
        r.exchange.toLowerCase().includes("inbound-smtp")
      );

      // Also check Google DNS propagation
      const googleCheck = await checkMxGoogle(d);

      results.push({
        domain: d,
        has_mx: sorted.length > 0,
        mx_records: sorted.map((r) => `${r.priority} ${r.exchange}`),
        can_receive: hasResendInbound,
        google_dns_propagated: googleCheck.has_mx,
      });
    } catch {
      // Server DNS failed, try Google DNS as fallback
      const googleCheck = await checkMxGoogle(d);

      results.push({
        domain: d,
        has_mx: googleCheck.has_mx,
        mx_records: googleCheck.records,
        can_receive: googleCheck.records.some((r: string) =>
          r.toLowerCase().includes("resend") || r.toLowerCase().includes("inbound-smtp")
        ),
        google_dns_propagated: googleCheck.has_mx,
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
