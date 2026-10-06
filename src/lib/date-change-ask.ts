/**
 * date-change-ask — pure detector for "customer wants to move / push / skip / delay / pause
 * their next order" asks. Phase 2 of [[../../docs/brain/specs/inflection-resession-must-act-on-newest-ask.md]].
 *
 * Ground truth: ticket dc31bf31 (Aug 2026). At 2026-08-05 14:14 the customer wrote
 * "Can we move order to Oct 30th as I ordered enough Aug n Sept???????". The frustration
 * detector classified it kind='frustration' (cues=['repeated_punct']) and Sol re-answered
 * his old Sep-2 ship-date question instead of moving the date, so the customer was billed
 * four weeks early → $237.16 refund + cancelled subscriber.
 *
 * Signature:
 *   detectDateChangeAsk(text) → { isAsk: boolean; requestedDate: string | null }
 *
 * The function is PURE (no DB, no network, no clock) so unified-ticket-handler's send-path
 * gate can call it synchronously without a step.run() wrapper, and the unit tests from the
 * dc31bf31 transcript (fire on "14:14 Can we move order to Oct 30th as I ordered enough
 * Aug n Sept???????"; stay silent on "14:06 Thank you So much!!!!!") exercise it offline.
 *
 * requestedDate semantics: a best-effort ISO `YYYY-MM-DD` when the message pins a concrete
 * day — never fabricated. "Oct 30th" / "10/30" resolve; "next month" / "soon" return null
 * on the day but still fire `isAsk:true` so the gate can escalate to a clarifying question
 * (the Direction's job, not the detector's). "YYYY-MM-DD" literals pass through verbatim.
 *
 * The detector errs on the side of RECALL — a false `isAsk:true` just defers the send and
 * re-sessions Sol (which is cheap and fully recoverable); a false `isAsk:false` is the
 * dc31bf31 miss (expensive, unrecoverable). The verb list is deliberately broad.
 */

export interface DateChangeAsk {
  /** True when the message contains BOTH a change-verb and a date-like token. */
  isAsk: boolean;
  /**
   * Best-effort ISO date (`YYYY-MM-DD`) when the message pins a concrete day. `null` when
   * the ask is real but the date is ambiguous ("next month", "later", "soon") — the
   * downstream gate turns that into a clarifying-question requirement.
   */
  requestedDate: string | null;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

// Verbs the customer uses when asking us to move / push / skip / delay / pause their next
// order. Lightly stemmed — "pushing", "moved" etc. all survive the \b anchor + ing/ed suffix.
const CHANGE_VERBS = [
  "push",
  "pushed",
  "pushing",
  "move",
  "moved",
  "moving",
  "shift",
  "shifted",
  "shifting",
  "delay",
  "delayed",
  "delaying",
  "postpone",
  "postponed",
  "postponing",
  "skip",
  "skipped",
  "skipping",
  "pause",
  "paused",
  "pausing",
  "hold off",
  "hold it off",
  "reschedule",
  "rescheduled",
  "rescheduling",
  "change",
  "changing",
];

const CHANGE_VERB_PATTERN = new RegExp(
  `\\b(?:${CHANGE_VERBS.map((v) => v.replace(/\s+/g, "\\s+")).join("|")})\\b`,
  "i",
);

// Context that disambiguates a change-verb into a date-change ask. "move my address",
// "pause my music" etc. don't fire — these anchors keep the subject tied to the next order
// / renewal / shipment / subscription / billing cycle.
const ORDER_SUBJECT_PATTERN =
  /\b(?:order|shipment|delivery|renewal|renew|refill|box|package|charge|billing|bill|subscription|cycle|next\s+(?:one|order|shipment|delivery|charge|box|renewal)|the\s+next\s+(?:one|order|shipment|delivery|charge|box|renewal))\b/i;

// Date-like tokens the detector can resolve to an ISO day.
// (1) ISO literal: 2026-10-30
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
// (2) US numeric: 10/30 or 10/30/2026
const US_SLASH_DATE =
  /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/;
// (3) Month-name date: "Oct 30", "October 30th", "Oct. 30, 2026"
const MONTH_NAME_DATE = new RegExp(
  `\\b(${Object.keys(MONTHS).join("|")})\\.?\\s+` +
    `(\\d{1,2})(?:st|nd|rd|th)?(?:[,\\s]+(\\d{2,4}))?\\b`,
  "i",
);

// Ambiguous date tokens — fire the ask but leave requestedDate null so the gate drives a
// clarifying-question Direction.
const AMBIGUOUS_DATE_PATTERN =
  /\b(?:next\s+(?:week|month|cycle)|later(?:\s+this\s+(?:week|month))?|soon|few\s+(?:days|weeks)|couple\s+(?:days|weeks)|end\s+of\s+(?:the\s+)?(?:month|week))\b/i;

function parseIso(y: string, m: string, d: string): string | null {
  const yy = Number(y);
  const mm = Number(m);
  const dd = Number(d);
  if (!Number.isFinite(yy) || !Number.isFinite(mm) || !Number.isFinite(dd)) return null;
  if (mm < 1 || mm > 12) return null;
  if (dd < 1 || dd > 31) return null;
  const yyyy = yy < 100 ? 2000 + yy : yy;
  return `${String(yyyy).padStart(4, "0")}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

/**
 * Pure date-ask detector. See the file-top docstring for semantics.
 */
export function detectDateChangeAsk(text: string): DateChangeAsk {
  const t = (text ?? "").toString();
  if (!t.trim()) return { isAsk: false, requestedDate: null };

  const verbHit = CHANGE_VERB_PATTERN.test(t);

  // A concrete calendar date on its own (even without a verb) is treated as an ask when it
  // co-occurs with a subject anchor — "my next order Oct 30" is still a date-change ask.
  const monthMatch = MONTH_NAME_DATE.exec(t);
  const isoMatch = ISO_DATE.exec(t);
  const slashMatch = US_SLASH_DATE.exec(t);
  const ambiguousMatch = AMBIGUOUS_DATE_PATTERN.test(t);

  const hasConcreteDate = !!(monthMatch || isoMatch || slashMatch);
  const subjectHit = ORDER_SUBJECT_PATTERN.test(t);

  // The ask fires on EITHER:
  //   (a) a change-verb AND (a date token OR an order-subject anchor), OR
  //   (b) a concrete date AND an order-subject anchor (no verb needed — "my next shipment
  //       Oct 30" is a date pin even without a verb like "move").
  // Pure verb with no date/subject (e.g. "move it along") stays silent — too noisy.
  const isAsk =
    (verbHit && (hasConcreteDate || ambiguousMatch || subjectHit)) ||
    (hasConcreteDate && subjectHit);

  if (!isAsk) return { isAsk: false, requestedDate: null };

  // Resolve the day when the message pinned one; leave null on ambiguous tokens.
  if (isoMatch) {
    const iso = parseIso(isoMatch[1]!, isoMatch[2]!, isoMatch[3]!);
    if (iso) return { isAsk: true, requestedDate: iso };
  }
  if (monthMatch) {
    const monthKey = monthMatch[1]!.toLowerCase();
    const month = MONTHS[monthKey];
    const day = Number(monthMatch[2]!);
    const yearTok = monthMatch[3];
    const year = yearTok ? (yearTok.length === 2 ? 2000 + Number(yearTok) : Number(yearTok)) : null;
    // No year on the message → the gate's job to resolve it from the ticket's subscription
    // (the detector is pure; it never guesses future vs past from a clock). Return the
    // partial `MM-DD` as `0000-MM-DD` so the downstream gate can post the full year in its
    // internal note — the sentinel 0000 year is unambiguously "needs year".
    if (month && day >= 1 && day <= 31) {
      const yyyy = year && Number.isFinite(year) ? String(year).padStart(4, "0") : "0000";
      return { isAsk: true, requestedDate: `${yyyy}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` };
    }
  }
  if (slashMatch) {
    const a = Number(slashMatch[1]!);
    const b = Number(slashMatch[2]!);
    const yearTok = slashMatch[3];
    // US convention: MM/DD or MM/DD/YYYY.
    if (a >= 1 && a <= 12 && b >= 1 && b <= 31) {
      const yyyy = yearTok
        ? (yearTok.length === 2 ? 2000 + Number(yearTok) : Number(yearTok))
        : null;
      const y = yyyy && Number.isFinite(yyyy) ? String(yyyy).padStart(4, "0") : "0000";
      return { isAsk: true, requestedDate: `${y}-${String(a).padStart(2, "0")}-${String(b).padStart(2, "0")}` };
    }
  }
  // Ambiguous-only ask (verb + "next month" / "soon") — fire with no concrete date; the
  // gate turns this into a clarifying-question Direction.
  return { isAsk: true, requestedDate: null };
}

/**
 * Decision-shape helper the send-path gate uses to decide whether an orchestrator decision
 * about to ship actually addresses a detected date-change ask. The three "satisfying"
 * action types are the ones that MOVE / SKIP / PAUSE the next order; a clarifying question
 * (reply drafted but needs_clarification=true) also satisfies the ask by deferring to the
 * customer.
 */
export function decisionAddressesDateChange(decision: {
  actions?: Array<{ type?: string }> | null;
  needs_clarification?: boolean;
  clarification_question?: string | null;
}): boolean {
  const actions = decision.actions ?? [];
  for (const a of actions) {
    const t = (a?.type ?? "").toString().toLowerCase();
    if (t === "change_next_date" || t === "skip_next_order" || t === "pause") return true;
  }
  if (decision.needs_clarification === true) return true;
  if (typeof decision.clarification_question === "string" && decision.clarification_question.trim().length > 0) return true;
  return false;
}
