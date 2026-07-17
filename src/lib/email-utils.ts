/**
 * Strip email signatures from HTML email bodies for cleaner display.
 * Preserves the full body in storage — this is display-only.
 */
export function stripEmailSignature(html: string): string {
  if (!html) return html;

  let cleaned = html;

  // WiseStamp signature: contains wisestamp.com URLs — remove the entire containing table
  // Find the first table that references wisestamp and remove everything from it onward
  const wsIndex = cleaned.search(/wisestamp\.com/i);
  if (wsIndex > -1) {
    // Walk backward to find the outermost table containing WiseStamp
    let tableStart = cleaned.lastIndexOf("<table", wsIndex);
    // Walk further back to find the parent div/container
    const beforeTable = cleaned.substring(0, tableStart);
    const parentDiv = beforeTable.lastIndexOf("<div");
    if (parentDiv > -1 && tableStart - parentDiv < 200) {
      cleaned = cleaned.substring(0, parentDiv);
    } else {
      cleaned = cleaned.substring(0, tableStart);
    }
  }

  // Gmail signature: <div class="gmail_signature" ...>...</div>
  cleaned = cleaned.replace(/<div[^>]*class="gmail_signature"[^>]*>[\s\S]*?<\/div>\s*<\/div>/gi, "");

  // Gmail extra: <div class="gmail_signature_prefix">--</div> and everything after
  cleaned = cleaned.replace(/<div[^>]*class="gmail_signature_prefix"[^>]*>[\s\S]*/gi, "");

  // Outlook signature: <div id="Signature">...</div> or <div id="signature">...</div>
  cleaned = cleaned.replace(/<div[^>]*id="[Ss]ignature"[^>]*>[\s\S]*?<\/div>/gi, "");

  // Outlook/Apple: <div id="AppleMailSignature">...</div>
  cleaned = cleaned.replace(/<div[^>]*id="AppleMailSignature"[^>]*>[\s\S]*?<\/div>/gi, "");

  // Standard signature delimiter: "-- " on its own line (RFC 3676)
  // In HTML this appears as <br>-- <br> or <div>-- </div> or similar
  cleaned = cleaned.replace(/<br\s*\/?>\s*--\s*<br\s*\/?>[\s\S]*/gi, "");
  cleaned = cleaned.replace(/<div[^>]*>\s*--\s*<\/div>[\s\S]*/gi, "");
  cleaned = cleaned.replace(/<p[^>]*>\s*--\s*<\/p>[\s\S]*/gi, "");

  // "Sent from my iPhone/iPad" and similar
  cleaned = cleaned.replace(/<br\s*\/?>\s*Sent from my\s+(iPhone|iPad|Galaxy|Samsung|Android)[\s\S]*/gi, "");
  cleaned = cleaned.replace(/<div[^>]*>\s*Sent from my\s+(iPhone|iPad|Galaxy|Samsung|Android)[\s\S]*/gi, "");

  // Clean up trailing whitespace and empty tags
  cleaned = cleaned.replace(/(<br\s*\/?>|\s)*$/gi, "");
  cleaned = cleaned.replace(/<div[^>]*>\s*<\/div>\s*$/gi, "");

  return cleaned.trim();
}

/**
 * Strip quoted reply content from inbound emails.
 * Keeps only the new content the customer wrote.
 */
export function stripQuotedReply(html: string): string {
  if (!html) return html;

  let cleaned = html;

  // Gmail quoted reply: <div class="gmail_quote">...</div>
  cleaned = cleaned.replace(/<div[^>]*class="gmail_quote"[^>]*>[\s\S]*/gi, "");

  // Outlook quoted reply: starts with <div id="appendonsend"></div> then original
  cleaned = cleaned.replace(/<div[^>]*id="appendonsend"[^>]*>[\s\S]*/gi, "");

  // Generic "On <date> <person> wrote:" pattern
  cleaned = cleaned.replace(/<blockquote[^>]*>[\s\S]*<\/blockquote>/gi, "");

  // "On Mon, Jan 1, 2026 at 10:00 AM <email> wrote:" and everything after
  cleaned = cleaned.replace(/<div[^>]*>On\s+\w{3},\s+\w{3}\s+\d{1,2},\s+\d{4}[\s\S]*/gi, "");

  return cleaned.trim();
}

/**
 * Clean an inbound email body for display: strip signature + quoted reply.
 */
export function cleanEmailForDisplay(html: string): string {
  let cleaned = stripQuotedReply(html);
  cleaned = stripEmailSignature(cleaned);
  return cleaned || html; // Fallback to original if stripping removed everything
}

/**
 * Canonicalize an email address so two strings that resolve to the same
 * real inbox compare equal. Pure — no I/O.
 *
 * - Always trim + lowercase.
 * - For gmail.com / googlemail.com ONLY: remove all "." from the local part,
 *   drop everything from the first "+" in the local part, and normalize the
 *   domain to gmail.com.
 * - For every other domain: return the trimmed-lowercased address as-is.
 *   Providers other than Gmail generally treat dots as significant, so
 *   stripping them would fuse distinct inboxes.
 *
 * Malformed input (no "@", empty local, empty domain) is returned lowercased
 * + trimmed so the caller can still compare it as a plain string — this
 * mirrors what an exact-string lookup would see today.
 */
export function canonicalizeEmail(email: string): string {
  const trimmed = (email ?? "").trim().toLowerCase();
  if (!trimmed) return trimmed;
  const atIdx = trimmed.lastIndexOf("@");
  if (atIdx <= 0 || atIdx === trimmed.length - 1) return trimmed;
  const localRaw = trimmed.slice(0, atIdx);
  const domain = trimmed.slice(atIdx + 1);
  const isGmail = domain === "gmail.com" || domain === "googlemail.com";
  if (!isGmail) return `${localRaw}@${domain}`;
  const plusIdx = localRaw.indexOf("+");
  const localNoPlus = plusIdx >= 0 ? localRaw.slice(0, plusIdx) : localRaw;
  const localNoDots = localNoPlus.replace(/\./g, "");
  return `${localNoDots}@gmail.com`;
}
