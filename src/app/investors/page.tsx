import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { CfoFinancials } from "@/components/agents/cfo-financials";
import {
  INVESTORS_COOKIE_NAME,
  isInvestorRole,
  verifyInvestorSession,
} from "@/lib/investors/auth";

// The proxy already gates /investors on a valid cookie, but we re-verify here so a
// stale/forged cookie can never render the page, and to greet the viewer by name.
export default async function InvestorsPage() {
  const cookieStore = await cookies();
  const session = verifyInvestorSession(cookieStore.get(INVESTORS_COOKIE_NAME)?.value);
  if (!session) redirect("/investors/expired");

  const admin = createAdminClient();
  const { data: customer } = await admin
    .from("customers")
    .select("first_name, comp_role")
    .eq("id", session.customerId)
    .maybeSingle();
  if (!customer || !isInvestorRole(customer.comp_role)) redirect("/investors/expired");

  const hi = customer.first_name ? `, ${customer.first_name}` : "";

  return (
    <>
      <section className="inv-hero">
        <h1>How Superfoods is doing{hi}</h1>
        <p>
          A private look at the numbers that run the business — revenue, profit, and the biggest
          things that move them. Every chart is on its own scale, so you can see the shape of each
          line clearly. Hover any point for that month; use the range buttons to zoom in on a year
          or a quarter.
        </p>
      </section>
      <section className="inv-charts">
        <CfoFinancials endpoint="/api/investors/pnl" />
      </section>
    </>
  );
}
