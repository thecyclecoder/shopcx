import { createAdminClient } from "@/lib/supabase/admin";

export interface PatternMatch {
  patternId: string;
  category: string;
  name: string;
  autoTag: string | null;
  autoAction: string | null;
  matchedPhrase: string;
}

interface SmartPattern {
  id: string;
  workspace_id: string | null;
  category: string;
  name: string;
  phrases: string[];
  match_target: string;
  priority: number;
  auto_tag: string | null;
  auto_action: string | null;
  active: boolean;
}

function cleanText(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, " ")       // strip HTML tags
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[^\w\s'''-]/g, "")    // keep letters, numbers, apostrophes, hyphens
    // Strip email signatures and quoted replies
    .split(/(?:sent from|get outlook|on .+ wrote:|from:|----)/)[0]
    .trim();
}

export async function matchPatterns(
  workspaceId: string,
  subject: string | null,
  body: string,
): Promise<PatternMatch | null> {
  const admin = createAdminClient();

  // Load global patterns + workspace patterns
  const { data: allPatterns } = await admin
    .from("smart_patterns")
    .select("*")
    .eq("active", true)
    .or(`workspace_id.is.null,workspace_id.eq.${workspaceId}`)
    .order("priority", { ascending: false });

  if (!allPatterns || allPatterns.length === 0) return null;

  // Load workspace overrides for global patterns
  const { data: overrides } = await admin
    .from("workspace_pattern_overrides")
    .select("pattern_id, enabled")
    .eq("workspace_id", workspaceId);

  const overrideMap = new Map<string, boolean>();
  for (const o of overrides || []) {
    overrideMap.set(o.pattern_id, o.enabled);
  }

  // Filter patterns: respect overrides for global ones
  const patterns = (allPatterns as SmartPattern[]).filter((p) => {
    if (p.workspace_id) return true; // workspace patterns always active if active=true
    // Global pattern: check if workspace has an override
    const override = overrideMap.get(p.id);
    if (override === false) return false; // explicitly dismissed
    return true; // enabled by default
  });

  const cleanedSubject = subject ? cleanText(subject) : "";
  const cleanedBody = cleanText(body);

  for (const pattern of patterns) {
    const phrases = (pattern.phrases || []) as string[];
    const textToCheck = pattern.match_target === "subject"
      ? cleanedSubject
      : pattern.match_target === "body"
        ? cleanedBody
        : `${cleanedSubject} ${cleanedBody}`;

    for (const phrase of phrases) {
      if (textToCheck.includes(phrase.toLowerCase())) {
        return {
          patternId: pattern.id,
          category: pattern.category,
          name: pattern.name,
          autoTag: pattern.auto_tag ? `smart:${pattern.auto_tag}` : null,
          autoAction: pattern.auto_action,
          matchedPhrase: phrase,
        };
      }
    }
  }

  return null;
}
