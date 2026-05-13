/**
 * Lightweight language detection + translation for inbound/outbound
 * tickets. Used to:
 *   - Detect a customer's language on the first inbound message and
 *     persist it on tickets.detected_language.
 *   - Run any canned outbound text (playbook macros, holding
 *     messages, journey CTAs) through a translation pass so a
 *     Spanish-speaking customer doesn't get an English template.
 *
 * Both functions hit Claude Haiku — cheap + fast. A typical Spanish
 * ticket adds two Haiku calls (one detect, one translate per
 * outbound), pennies of cost. English passes through unchanged with
 * no API call.
 */

import { logAiUsage } from "@/lib/ai-usage";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const API_URL = "https://api.anthropic.com/v1/messages";

const SUPPORTED_LANGS = new Set([
  "en", "es", "fr", "de", "it", "pt", "nl", "ja", "ko", "zh",
]);

/**
 * Best-effort language detection. Returns an ISO-639-1 code (lowercased,
 * 2 chars) on success, or "en" as a safe default when detection fails
 * or the message is too short to classify reliably. The model is told
 * to ONLY return the code so the caller never has to parse prose.
 */
export async function detectLanguage(
  text: string,
  opts: { workspaceId?: string; ticketId?: string } = {},
): Promise<string> {
  const trimmed = (text || "").trim();
  if (trimmed.length < 4) return "en";
  // Fast-path: HTML-heavy or template-y text → assume English to
  // avoid wasting a Haiku call on system noise.
  if (trimmed.length > 8000) return "en";

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return "en";

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 8,
        messages: [
          {
            role: "user",
            content:
              `Detect the language of this customer support message. Reply with ONLY the two-letter ISO 639-1 code (e.g. "en", "es", "fr"). No punctuation, no explanation.\n\n---\n${trimmed.slice(0, 600)}`,
          },
        ],
      }),
    });
    if (!res.ok) return "en";
    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    if (opts.workspaceId) {
      void logAiUsage({
        workspaceId: opts.workspaceId,
        model: HAIKU_MODEL,
        usage: data.usage,
        purpose: "detect-language",
        ticketId: opts.ticketId,
      });
    }
    const raw = (data.content || []).find((b) => b.type === "text")?.text || "";
    const code = raw.trim().toLowerCase().slice(0, 2);
    return SUPPORTED_LANGS.has(code) ? code : "en";
  } catch {
    return "en";
  }
}

/**
 * Translate `text` into `targetLang` while preserving HTML structure,
 * brand names, placeholders ({{like_this}}), URLs, tracking numbers,
 * and product names. No-op when targetLang === "en" or unknown.
 *
 * The model is instructed to return ONLY the translation (no preface),
 * so the caller can drop the result straight into a message body.
 */
export async function translateIfNeeded(
  text: string,
  targetLang: string,
  opts: { workspaceId?: string; ticketId?: string } = {},
): Promise<string> {
  if (!text) return text;
  const lang = (targetLang || "en").toLowerCase();
  if (lang === "en" || !SUPPORTED_LANGS.has(lang)) return text;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return text;

  const langName = ISO_TO_NAME[lang] || lang;

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 2000,
        system: `You translate customer-support messages into ${langName}. Rules:
- Output ONLY the translated text, no preface, no explanation.
- Preserve all HTML tags exactly.
- Preserve all URLs, tracking numbers, order numbers (e.g. SC129756), and email addresses.
- Preserve brand + product names (Superfood Tabs, Mixed Berry, etc).
- Keep template placeholders unchanged ({{like_this}}, [LABEL_URL], etc).
- Use natural, friendly customer-support voice in ${langName}.`,
        messages: [{ role: "user", content: text }],
      }),
    });
    if (!res.ok) return text;
    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    if (opts.workspaceId) {
      void logAiUsage({
        workspaceId: opts.workspaceId,
        model: HAIKU_MODEL,
        usage: data.usage,
        purpose: `translate:${lang}`,
        ticketId: opts.ticketId,
      });
    }
    const translated = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text || "")
      .join("");
    return translated.trim() || text;
  } catch {
    return text;
  }
}

const ISO_TO_NAME: Record<string, string> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
  nl: "Dutch",
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
};

export function languageName(code: string): string {
  return ISO_TO_NAME[(code || "en").toLowerCase()] || "English";
}
