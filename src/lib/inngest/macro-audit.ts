// Inngest function: audit macros against product intelligence
// Processes macros one by one, updating progress in macro_audit_jobs table

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";

const SONNET = "claude-sonnet-4-20250514";

async function aiCall(system: string, user: string, maxTokens = 600): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return "";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({ model: SONNET, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) return `(AI error: ${res.status})`;
  const data = await res.json();
  return (data.content?.[0] as { text: string })?.text?.trim() || "";
}

export const macroAuditFunction = inngest.createFunction(
  {
    id: "macro-audit",
    retries: 1,
    concurrency: [{ limit: 1, key: "event.data.workspace_id" }],
    triggers: [{ event: "macro-audit/start" }],
  },
  async ({ event, step }) => {
    const { workspace_id, job_id, product_intelligence_id } = event.data as {
      workspace_id: string; job_id: string; product_intelligence_id: string;
    };

    const admin = createAdminClient();

    // Load product intelligence
    const pi = await step.run("load-pi", async () => {
      const { data } = await admin.from("product_intelligence")
        .select("id, product_id, title, content, labeled_urls")
        .eq("id", product_intelligence_id).eq("workspace_id", workspace_id).single();
      return data;
    });

    if (!pi) {
      await admin.from("macro_audit_jobs").update({ status: "failed", error: "Product intelligence not found" }).eq("id", job_id);
      return { error: "Product intelligence not found" };
    }

    // Find macros
    const macros = await step.run("find-macros", async () => {
      const { data } = await admin.from("macros")
        .select("id, name, body_text, category, active")
        .eq("workspace_id", workspace_id)
        .or(`product_id.eq.${pi.product_id},name.ilike.%${pi.title}%`)
        .order("name");
      return data || [];
    });

    // Update job with total count
    await step.run("set-total", () =>
      admin.from("macro_audit_jobs").update({ status: "running", total: macros.length, updated_at: new Date().toISOString() }).eq("id", job_id)
    );

    if (macros.length === 0) {
      await admin.from("macro_audit_jobs").update({ status: "completed", results: [] }).eq("id", job_id);
      return { total: 0 };
    }

    const intelligenceContext = pi.content.slice(0, 8000);
    const labeledUrls = (pi.labeled_urls as { url: string; label: string }[]) || [];
    const urlReference = labeledUrls.length > 0
      ? "\n\nPRODUCT URLS (use these in macros when relevant):\n" + labeledUrls.map((u: { url: string; label: string }) => `- ${u.label}: ${u.url}`).join("\n")
      : "";

    const systemPrompt = `You are auditing a customer support macro against product intelligence data. Your job is to rewrite the macro to be accurate, concise, professional, and aligned with the product intelligence.

RULES:
- No emoji. No greetings (no "Hi!", "Hello!", "Hey there!"). No fluff closings ("Have a great day!", "Thanks for being part of our community!").
- Remove ALL YouTube links.
- Fix or remove broken links (ending in ! , . or with trailing punctuation).
- Replace old/broken links with the correct labeled product URLs provided below. Include relevant links in macros — customers appreciate direct links to reviews, ingredients, how it works, etc.
- Cross-reference claims against the product intelligence — fix any inaccurate claims.
- Keep it concise — max 2-3 sentences per paragraph. No walls of text. Short, scannable paragraphs.
- If the macro references a specific product feature, use the EXACT claim from the product intelligence (ingredients, dosages, clinical studies).
- Output HTML format: use <p> tags for paragraphs, <a href="url"> for hyperlinked text (not raw URLs — always hyperlink with descriptive text like "check out our reviews" or "see the full ingredient list").
- The AI agent will add greetings and sign-offs — the macro should be just the factual content.

Return JSON: { "rewritten_html": "the rewritten macro in HTML", "rewritten_text": "plain text version", "changes": ["list of changes made"], "accuracy_issues": ["any claims that don't match the intelligence"] }`;

    // Process each macro
    for (let i = 0; i < macros.length; i++) {
      const macro = macros[i];
      const text = macro.body_text || "";

      const result = await step.run(`audit-macro-${i}`, async () => {
        const hasEmoji = /[\u{1F300}-\u{1FFFF}]/u.test(text);
        const hasYoutube = /youtube\.com|youtu\.be/i.test(text);
        const hasGreeting = /^(hi|hey|hello|thanks|thank you)/im.test(text);
        const links = text.match(/https?:\/\/[^\s)]+/g) || [];
        const hasFluff = /hope you.*day|hope this finds|part of the.*community|anything else we can|have a (great|wonderful)/i.test(text);

        const issues: string[] = [];
        if (hasEmoji) issues.push("contains emoji");
        if (hasYoutube) issues.push("contains YouTube link");
        if (hasGreeting) issues.push("starts with greeting");
        if (hasFluff) issues.push("contains fluff/filler");
        if (links.some((l: string) => l.endsWith("!") || l.endsWith(",") || l.endsWith("."))) issues.push("broken link(s)");

        const raw = await aiCall(
          systemPrompt,
          `PRODUCT INTELLIGENCE:\n${intelligenceContext}${urlReference}\n\nCURRENT MACRO:\nName: ${macro.name}\nContent: ${text}`,
        );

        let rewrittenText = text;
        let rewrittenHtml = "";
        let changes: string[] = [];
        let accuracyIssues: string[] = [];

        try {
          const parsed = JSON.parse(raw.replace(/^```json?\n?/, "").replace(/\n?```$/, ""));
          rewrittenText = parsed.rewritten_text || parsed.rewritten || text;
          rewrittenHtml = parsed.rewritten_html || "";
          changes = parsed.changes || [];
          accuracyIssues = parsed.accuracy_issues || [];
        } catch {
          changes = ["Failed to parse AI response"];
        }

        return {
          macro_id: macro.id,
          macro_name: macro.name,
          category: macro.category,
          active: macro.active,
          original: text,
          rewritten: rewrittenText,
          rewritten_html: rewrittenHtml,
          changes,
          accuracy_issues: accuracyIssues,
          issues_detected: issues,
          has_changes: rewrittenText !== text,
        };
      });

      // Update progress
      await step.run(`update-progress-${i}`, async () => {
        const { data: job } = await admin.from("macro_audit_jobs").select("results").eq("id", job_id).single();
        const results = (job?.results as unknown[]) || [];
        results.push(result);
        await admin.from("macro_audit_jobs").update({
          completed: i + 1,
          results,
          updated_at: new Date().toISOString(),
        }).eq("id", job_id);
      });
    }

    // Mark completed
    await step.run("complete", () =>
      admin.from("macro_audit_jobs").update({ status: "completed", updated_at: new Date().toISOString() }).eq("id", job_id)
    );

    return { total: macros.length };
  },
);
