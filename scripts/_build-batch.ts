import { loadEnv, createAdminClient, pgClient } from "./_bootstrap";
loadEnv();
import { writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { mintReviewRequestToken } from "../src/lib/review-request-delivery";
import { validateReviewRequest } from "../src/lib/review-request-validator";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const LIMIT = 50;

type Row = {
  customer_id: string; first_name: string | null; email: string | null; phone: string | null;
  email_status: string; sms_status: string; ltv_cents: number;
  product_id: string; product_title: string; variant_id: string | null; variant_title: string | null;
  months_on_product: number; times_bought: number;
};

/** True, computed, per-person. Never invented. Null when we can't say anything specific. */
function handPickedFact(r: Row): string | null {
  if (r.months_on_product >= 2) return `you've been on ${r.product_title} for ${r.months_on_product} months now`;
  if (r.times_bought >= 3) return `you're ${r.times_bought} orders into ${r.product_title} now`;
  return null;
}

function buildSms(r: Row, link: string): string {
  const fact = handPickedFact(r);
  return [
    `Hey ${r.first_name || "there"}, you've always been the best at giving it to us straight.`, ``,
    `A reviewer just said "superfoods don't work."${fact ? ` Here's where you come in — ${fact}.` : " Here's where you come in."}`, ``,
    `What do you actually think of ${r.product_title}${r.variant_title ? ` ${r.variant_title}` : ""}?`, ``,
    `Click here (takes 1 min):`, link, ``,
    `$10 code waiting when you're done.`, ``,
    `Reply STOP to opt out`,
  ].join("\n");
}

function buildEmail(r: Row, link: string): { subject: string; body: string } {
  const fact = handPickedFact(r);
  return {
    subject: "quick favor?",
    body: `Hi ${r.first_name || "there"}, you've always been the best at giving it to us straight. Right now I need your help.

A reviewer named Erica F. said she didn't like Superfood products, and that superfoods aren't the way to live healthier.

So here's where you come in.${fact ? ` ${fact.charAt(0).toUpperCase()}${fact.slice(1)}.` : ""} Is Erica right? How are you liking ${r.product_title}${r.variant_title ? ` ${r.variant_title}` : ""}?

${link}

Click the link above and tell her what you actually think. Takes about a minute, and you'll get a $10 code right away for your time — whatever you say.

Thanks,
Dylan

--
Don't want notes like this from me? Just reply and say so.`,
  };
}

async function main() {
  const c = pgClient(); await c.connect();
  const { rows } = await c.query<Row>(`
    with win as (
      select o.id, o.customer_id, o.created_at
      from orders o where o.workspace_id = $1
        and o.created_at between now() - interval '40 days' and now() - interval '10 days'),
    pairs as (
      select distinct w.customer_id, p.id product_id, p.title product_title,
             li->>'variant_id' shop_variant, li->>'variant_title' variant_title
      from win w join orders o on o.id = w.id, lateral jsonb_array_elements(o.line_items) li
      join products p on p.shopify_product_id = li->>'product_id' and p.reviewable = true)
    select pr.customer_id, cu.first_name, cu.email, cu.phone,
      cu.email_marketing_status email_status, cu.sms_marketing_status sms_status, cu.ltv_cents,
      pr.product_id, pr.product_title, v.id variant_id, pr.variant_title,
      greatest(0, (extract(epoch from (now() - (
        select min(o2.created_at) from orders o2, lateral jsonb_array_elements(o2.line_items) l2
        where o2.customer_id = pr.customer_id and l2->>'product_id' = (select shopify_product_id from products where id = pr.product_id)
      )))/2629746)::int) months_on_product,
      (select count(*) from orders o3, lateral jsonb_array_elements(o3.line_items) l3
        where o3.customer_id = pr.customer_id and l3->>'product_id' = (select shopify_product_id from products where id = pr.product_id))::int times_bought
    from pairs pr
    join customers cu on cu.id = pr.customer_id
    left join product_variants v on v.shopify_variant_id = pr.shop_variant
    where cu.ltv_cents >= 30000
      and (select count(*) from orders o4 where o4.customer_id = pr.customer_id) >= 2
      and not exists (select 1 from product_reviews r where r.customer_id=pr.customer_id and r.product_id=pr.product_id)
      and not exists (select 1 from review_requests rq where rq.customer_id=pr.customer_id and rq.product_id=pr.product_id)
      and ((cu.email is not null and cu.email_marketing_status <> 'unsubscribed')
        or (cu.phone is not null and cu.sms_marketing_status = 'subscribed'))
    order by cu.ltv_cents desc
    limit $2`, [WS, LIMIT]);
  await c.end();

  const admin = createAdminClient();
  const { data: jd } = await admin.from("journey_definitions").select("id").eq("workspace_id", WS).eq("slug", "product-review").limit(1).single();

  const out: any[] = [];
  for (const r of rows) {
    const channel: "sms" | "email" = (r.phone && r.sms_status === "subscribed") ? "sms" : "email";
    const token = mintReviewRequestToken();
    const link = `https://shopcx.ai/review/${token}`;
    const sms = buildSms(r, link);
    const email = buildEmail(r, link);
    const body = channel === "sms" ? sms : email.body;
    const v = validateReviewRequest({ channel, body } as never);

    const { data: sess } = await admin.from("journey_sessions").insert({
      workspace_id: WS, journey_id: jd!.id, customer_id: r.customer_id,
      product_id: r.product_id, variant_id: r.variant_id,
      token, token_expires_at: new Date(Date.now() + 30 * 864e5).toISOString(), status: "pending",
    }).select("id").single();

    out.push({
      customer_id: r.customer_id, name: r.first_name, to: channel === "sms" ? r.phone : r.email,
      channel, ltv: `$${Math.round(r.ltv_cents / 100)}`, product: r.product_title, variant: r.variant_title,
      fact: handPickedFact(r), token, session_id: sess?.id ?? null,
      valid: v.allow, reasons: v.reasons, sms, email_subject: email.subject, email_body: email.body,
    });
  }
  writeFileSync(join(homedir(), "Desktop", "review-batch.json"), JSON.stringify(out, null, 2));
  const ok = out.filter(o => o.valid).length;
  console.log(`built ${out.length} drafts — ${ok} pass the validator, ${out.length - ok} fail`);
  console.log(`  sms=${out.filter(o=>o.channel==='sms').length} email=${out.filter(o=>o.channel==='email').length}`);
  console.log(`  with a computed fact: ${out.filter(o=>o.fact).length}`);
  for (const o of out.filter(o => !o.valid).slice(0,4)) console.log(`  FAIL ${o.name}: ${o.reasons.join(", ")}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
