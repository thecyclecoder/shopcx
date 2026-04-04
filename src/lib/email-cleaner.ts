/**
 * Email body cleaner — strips HTML, quoted replies, signatures, and noise.
 * Used on inbound email messages before the classifier and AI see them.
 *
 * Stores both versions:
 *   body (raw) — original untouched, shown in dashboard
 *   body_clean — cleaned output, used by AI/classifier
 */

import { convert } from "html-to-text";
import EmailReplyParser from "email-reply-parser";

/**
 * Clean an inbound email body for AI processing.
 * @param rawBody - The original email body (HTML or plain text)
 * @param senderEmail - The sender's email (used for signature hints)
 * @returns Cleaned plain text body
 */
export function cleanEmailBody(rawBody: string, senderEmail?: string): string {
  if (!rawBody || !rawBody.trim()) return rawBody || "";

  let text = rawBody;

  // 1. Convert HTML to plain text
  if (/<[a-zA-Z][^>]*>/.test(text)) {
    try {
      text = convert(text, {
        wordwrap: false,
        preserveNewlines: true,
        selectors: [
          { selector: "img", format: "skip" },
          { selector: "style", format: "skip" },
          { selector: "script", format: "skip" },
          { selector: "head", format: "skip" },
          { selector: "a", options: { ignoreHref: true } },
        ],
      });
    } catch {
      // Fallback: strip tags with regex
      text = text.replace(/<[^>]*>/g, " ");
    }
  }

  // Decode any remaining HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&[a-z]+;/gi, " ");

  // 2. Extract latest reply (strip quoted history)
  try {
    const parsed = new EmailReplyParser().read(text);
    const fragments = parsed.getFragments();
    // Get only non-quoted, non-signature fragments
    const visibleFragments = fragments.filter(
      (f: { isQuoted: () => boolean; isSignature: () => boolean; isHidden: () => boolean }) =>
        !f.isQuoted() && !f.isHidden()
    );
    if (visibleFragments.length > 0) {
      text = visibleFragments
        .map((f: { getContent: () => string }) => f.getContent())
        .join("\n")
        .trim();
    }
  } catch {
    // If parser fails, continue with full text
  }

  // 3. Strip email signatures using regex patterns
  text = stripSignature(text, senderEmail);

  // 4. Regex safety net for common patterns
  const lines = text.split("\n");
  const cleaned: string[] = [];
  let hitSignatureDelimiter = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Stop at signature delimiters
    if (/^[-–—]{2,}\s*$/.test(trimmed)) {
      hitSignatureDelimiter = true;
      break;
    }

    // Skip common mobile/app signatures
    if (/^Sent from my (iPhone|iPad|Android|Galaxy|Samsung|Pixel)/i.test(trimmed)) continue;
    if (/^Get Outlook for (iOS|Android|Mac|Windows)/i.test(trimmed)) continue;
    if (/^Sent from (Mail|Yahoo|AOL|Outlook)/i.test(trimmed)) continue;
    if (/^Sent via /i.test(trimmed)) continue;

    // Skip deeply nested quotes
    if (/^>{2,}/.test(trimmed)) continue;

    // Skip "On [date] [person] wrote:" quote headers
    if (/^On .+ wrote:\s*$/i.test(trimmed)) {
      hitSignatureDelimiter = true;
      break;
    }

    // Skip "From: / To: / Date: / Subject:" forwarded email headers
    if (/^(From|To|Date|Subject|Cc|Bcc):\s/i.test(trimmed) && cleaned.length > 0) {
      hitSignatureDelimiter = true;
      break;
    }

    cleaned.push(line);
  }

  text = (hitSignatureDelimiter ? cleaned : lines).join("\n");

  // 5. Normalize whitespace
  text = text
    .replace(/\n{3,}/g, "\n\n")  // Max 1 consecutive blank line
    .replace(/[ \t]+/g, " ")     // Collapse horizontal whitespace
    .trim();

  // 6. Never return empty — fall back to truncated raw
  if (!text) {
    const fallback = rawBody.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    return fallback.slice(0, 500);
  }

  return text;
}

/**
 * Strip email signature block from text.
 * Uses heuristics: name-like line followed by title/phone/email/address lines.
 */
function stripSignature(text: string, senderEmail?: string): string {
  const lines = text.split("\n");
  const senderLocal = senderEmail?.split("@")[0]?.toLowerCase() || "";
  const senderName = senderLocal.replace(/[^a-z]/g, " ").trim();

  // Look for signature block from the bottom up
  // A signature typically starts with a name line and is followed by
  // title, phone, email, URL, and/or address lines
  let signatureStart = -1;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;

    // Check if this looks like the start of a signature
    const isNameLine = /^[A-Z][a-z]+ [A-Z][a-z]+/.test(line) && line.length < 40;
    const isSenderName = senderName && line.toLowerCase().includes(senderName);

    if (isNameLine || isSenderName) {
      // Check if lines below this are signature-like
      const below = lines.slice(i + 1).map(l => l.trim()).filter(l => l);
      const sigPatterns = [
        /^(Founder|CEO|President|Director|Manager|Support|Sales|VP|CTO|COO|CFO|Owner|Partner|Agent|Analyst|Engineer|Consultant|Coordinator)/i,
        /\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/,  // Phone
        /[\w.+-]+@[\w.-]+\.\w+/,                   // Email
        /^https?:\/\//,                              // URL
        /^\d+\s+\w+\s+(Street|St|Ave|Avenue|Blvd|Road|Rd|Drive|Dr|Lane|Ln|Way|Court|Ct|Suite|Ste|Unit)/i, // Address
        /^[A-Z][a-z]+,\s*[A-Z]{2}\s+\d{5}/,        // City, ST ZIP
        /\|/,                                         // Pipe separators common in sigs
        /^www\./i,                                    // Website
      ];

      const sigLineCount = below.filter(l => sigPatterns.some(p => p.test(l))).length;
      if (sigLineCount >= 2 || (isSenderName && sigLineCount >= 1)) {
        signatureStart = i;
        break;
      }
    }

    // Don't look more than 15 lines up from the bottom
    if (lines.length - i > 15) break;
  }

  if (signatureStart >= 0) {
    return lines.slice(0, signatureStart).join("\n").trim();
  }

  return text;
}
