/**
 * Strip email signatures from HTML email bodies for cleaner display.
 * Preserves the full body in storage — this is display-only.
 */
export function stripEmailSignature(html: string): string {
  if (!html) return html;

  let cleaned = html;

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
