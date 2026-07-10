import { Suspense } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { CfoFinancials } from "@/components/agents/cfo-financials";
import {
  INVESTORS_COOKIE_NAME,
  isInvestorRole,
  verifyInvestorSession,
} from "@/lib/investors/auth";

// cacheComponents (PPR) is on — the cookie/DB read below is uncached dynamic
// data, so it MUST live inside a <Suspense> boundary (the static shell renders
// the fallback; the gated content streams at request time). Reading cookies at
// the page top level without this fails the prerender + breaks the build.
export default function InvestorsPage() {
  return (
    <Suspense
      fallback={
        <section className="inv-hero">
          <h1>How Superfoods is doing</h1>
          <p>Loading your update…</p>
        </section>
      }
    >
      <InvestorsContent />
    </Suspense>
  );
}

// The proxy already gates /investors on a valid cookie, but we re-verify here so a
// stale/forged cookie can never render the page, and to greet the viewer by name.
async function InvestorsContent() {
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
