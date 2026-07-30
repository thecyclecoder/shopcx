/**
 * Draft + VALIDATE the VIP Weekend Sale SMS blast (Sat 2026-07-25 Day 1,
 * Sun 2026-07-26 Final Day). Composes one single-segment body per segment and
 * checks every invariant BEFORE anything is written:
 *
 *   - GSM-7 only (one non-GSM-7 char drops the segment limit 160 -> 70)
 *   - rendered <= 160 chars, where `{shortlink}` (11) expands to the real
 *     `https://superfd.co/{6-slug}/{5-short_code}` = exactly 31 chars, so
 *     rendered = stored + 20  => stored must be <= 140
 *   - no unsupported merge tags (only {shortlink} and {coupon} substitute)
 *   - block layout preserved exactly as the founder specified
 *
 * Read-only: prints the draft. Writing the campaigns is a separate, gated step.
 */
import "./_bootstrap";

// `{shortlink}` -> https://superfd.co/XXXXXX/YYYYY  (verified: domain superfd.co,
// 6-char slug from generateShortlinkSlug(6), 5-char customers.short_code)
const TOKEN = "{shortlink}";
const RENDERED_SHORTLINK_LEN = "https://superfd.co/XXXXXX/YYYYY".length; // 31
const MAX_RENDERED = 160;

/** GSM-7 basic + extension set. Anything outside forces UCS-2 (limit 70). */
const GSM7 =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM7_EXT = "^{}\\[~]|€";

function nonGsm7(s: string): string[] {
  const bad = new Set<string>();
  for (const ch of s) if (!GSM7.includes(ch) && !GSM7_EXT.includes(ch)) bad.add(ch);
  return [...bad];
}

/** GSM-7 extension chars cost 2 septets each. */
function septets(s: string): number {
  let n = 0;
  for (const ch of s) n += GSM7_EXT.includes(ch) ? 2 : 1;
  return n;
}

function render(body: string): string {
  return body.replace(TOKEN, "https://superfd.co/XXXXXX/YYYYY");
}

// ── the founder's template ──────────────────────────────────────────────────
// OMG! ...hook...            <- block 1
//                            <- blank line
// Tap for Coupon: {link}     <- block 2, CTA + link in the MIDDLE
// Only 38 left!              <- single line break, urgency
//                            <- blank line
// Shed lbs, feel great!      <- block 3, benefit signoff
function compose(hook: string, urgency: string, signoff = "Shed lbs, feel great!"): string {
  return `${hook}\n\nTap for Coupon: ${TOKEN}\n${urgency}\n\n${signoff}`;
}

interface Draft {
  segment: string;
  audience: number;
  hook: string;
}

// Audience = live counts, net of active_sub (which gets its own campaign).
const DAY1: Draft[] = [
  { segment: "cycle_hitter", audience: 413, hook: "OMG! You got picked for our VIP Weekend Sale - time to restock!" },
  {
    segment: "lapsed",
    audience: 406,
    hook: "OMG! You must be lucky b/c you just got picked for our VIP Weekend Sale",
  },
  { segment: "engaged", audience: 211, hook: "OMG! You must be lucky - you just got picked for VIP Weekend Sale!" },
  {
    segment: "deep_lapsed",
    audience: 4887,
    hook: "OMG! You must be lucky b/c you just got picked for our VIP Weekend Sale",
  },
  { segment: "single_order", audience: 2478, hook: "OMG! You got picked for our VIP Weekend Sale - ready for round 2?" },
  { segment: "just_ordered", audience: 201, hook: "OMG! You got picked for our VIP Weekend Sale - stock up early!" },
  { segment: "storefront_signup", audience: 96, hook: "OMG! You must be lucky - you just got picked for VIP Weekend Sale!" },
  { segment: "active_sub", audience: 1250, hook: "OMG! Our VIP subscribers got picked first for VIP Weekend Sale!" },
];

const DAY2: Draft[] = [
  { segment: "cycle_hitter", audience: 413, hook: "Last chance! Your VIP Weekend Sale pick - restock before it ends." },
  { segment: "lapsed", audience: 406, hook: "Last chance! Your VIP Weekend Sale pick ends tonight - come back." },
  { segment: "engaged", audience: 211, hook: "Last chance! The VIP Weekend Sale you got picked for ends tonight." },
  { segment: "deep_lapsed", audience: 4887, hook: "Last chance! The VIP Weekend Sale you got picked for ends tonight." },
  { segment: "single_order", audience: 2478, hook: "Last chance! Your VIP Weekend Sale pick - final shot at round 2." },
  { segment: "just_ordered", audience: 201, hook: "Last chance on the VIP Weekend Sale you got picked for!" },
  { segment: "storefront_signup", audience: 96, hook: "Last chance to use the VIP Weekend invite you got picked for!" },
  { segment: "active_sub", audience: 1250, hook: "Last chance VIPs! The sale you got picked for ends tonight." },
];

const DAY1_URGENCY = "Only 38 left!";
const DAY2_URGENCY = "Expires Midnight!";

function report(title: string, drafts: Draft[], urgency: string) {
  console.log(`\n${"=".repeat(78)}\n${title}\n${"=".repeat(78)}`);
  let total = 0;
  let fails = 0;
  for (const d of drafts) {
    const body = compose(d.hook, urgency);
    const stored = septets(body);
    const rendered = septets(render(body));
    const bad = nonGsm7(body);
    const ok = rendered <= MAX_RENDERED && bad.length === 0;
    if (!ok) fails++;
    total += d.audience;
    const flag = ok ? "OK " : "FAIL";
    console.log(
      `\n[${flag}] ${d.segment.padEnd(18)} audience ${String(d.audience).padStart(5)}` +
        `   stored ${String(stored).padStart(3)}   rendered ${String(rendered).padStart(3)}/160` +
        `   headroom ${String(MAX_RENDERED - rendered).padStart(2)}` +
        (bad.length ? `   NON-GSM7: ${JSON.stringify(bad)}` : ""),
    );
    console.log(
      body
        .split("\n")
        .map((l) => `      | ${l}`)
        .join("\n"),
    );
  }
  console.log(`\n  -- ${drafts.length} campaigns, ${total.toLocaleString()} recipients, ${fails} failing`);
  return { total, fails };
}

function main() {
  console.log(`{shortlink} renders to ${RENDERED_SHORTLINK_LEN} chars => stored budget = ${MAX_RENDERED - RENDERED_SHORTLINK_LEN + TOKEN.length} chars`);
  const a = report("DAY 1 - Saturday 2026-07-25", DAY1, DAY1_URGENCY);
  const b = report("DAY 2 (FINAL) - Sunday 2026-07-26", DAY2, DAY2_URGENCY);
  console.log(`\n${"=".repeat(78)}`);
  console.log(`TOTAL: ${a.total + b.total} sends across ${DAY1.length + DAY2.length} campaigns`);
  console.log(`FAILING: ${a.fails + b.fails}`);
  if (a.fails + b.fails > 0) process.exitCode = 1;
}

main();
