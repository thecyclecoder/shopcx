/**
 * Inbound image-only detection for the ticket pipeline.
 *
 * An email/portal reply whose body is ONLY an image — a pasted photo
 * (`<img src="data:image/jpeg;base64,…">`), an inline attachment, or a bare image
 * URL — strips to an empty string once HTML tags are removed. The unified handler's
 * empty-inbound guard then treated it as a no-op and skipped the whole pipeline, so
 * the customer's photo went unanswered and the ticket sat open (susansproviero
 * 7fee980d: a follow-up photo of expired product, no caption, silently dropped).
 *
 * An image-only reply is NOT empty — the customer sent a picture (a receipt, a damaged
 * item, a screenshot) expecting a response. This module lets the handler distinguish
 * "genuinely empty" (quoted thread / signature only → still skip) from "image-only"
 * (route to Sol with a marker so she acknowledges the photo and asks what's needed).
 *
 * We do NOT interpret the image (no vision in-pipeline yet) and we do NOT mutate the
 * stored message body — the raw image stays in `ticket_messages.body` so the human
 * dashboard still renders the photo. The Sonnet orchestrator already strips `<img>`
 * tags from history + caps length, so nothing here risks a base64 context blow-up.
 */

/** The synthetic newest-message text handed to the orchestrator for an image-only inbound. */
export const IMAGE_ONLY_INBOUND_MARKER =
  "[The customer replied with only a photo/image attachment and no text caption. " +
  "Acknowledge the photo you received and ask them, in one short line, what they'd " +
  "like help with — do not guess what the image shows.]";

const IMG_TAG = /<img\b[^>]*>/i;
const DATA_IMAGE = /\bdata:image\//i;
const IMAGE_URL = /https?:\/\/\S+\.(?:jpe?g|jpg|png|gif|webp|heic|heif)\b/i;

/** True when the raw (pre-strip) body carries an inline image, image data-URI, or image URL. */
export function inboundHasImage(rawBody: string | null | undefined): boolean {
  const s = rawBody || "";
  return IMG_TAG.test(s) || DATA_IMAGE.test(s) || IMAGE_URL.test(s);
}

/** The plain-text remainder after stripping HTML tags + entities (same shape the handler uses). */
export function strippedInboundText(rawBody: string | null | undefined): string {
  return (rawBody || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&[^;]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Classify an inbound reply body. `isEmptyText` — no text survives stripping.
 * `isImageOnly` — empty of text BUT carries an image (so it must NOT be skipped).
 */
export function classifyEmptyInbound(rawBody: string | null | undefined): {
  isEmptyText: boolean;
  isImageOnly: boolean;
} {
  const isEmptyText = strippedInboundText(rawBody).length === 0;
  return { isEmptyText, isImageOnly: isEmptyText && inboundHasImage(rawBody) };
}
