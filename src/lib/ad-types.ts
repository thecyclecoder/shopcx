/**
 * Ad tool — shared types. Kept in a leaf module so ad-angles.ts (generator) and
 * ad-validator.ts (gate) can both depend on them without a circular import.
 */
import type { UrgencyLever, VibeTag } from "@/lib/ad-tool-config";

/** The typed input the angle generator + validator consume (Phase 0.5 contract). */
export interface AngleGeneratorInput {
  product_id: string;
  product_title: string;

  // Tier 1 — leading promise
  hero_headline: string;
  hero_subheadline: string;
  benefit_bar: Array<{ text: string; icon_hint?: string }>;
  guarantee_copy: string;
  expectation_timeline: Array<{ time_label: string; headline: string; body: string }>;

  // Tier 2 — lead benefits with science + customer language pairing
  lead_benefits: Array<{
    name: string;
    customer_phrases: string[];
    ingredient_research_ids: string[];
    ai_confidence: number;
  }>;

  // Tier 3 — mechanism / science
  ingredient_science: Array<{
    ingredient_name: string;
    benefit_headline: string;
    clinically_studied_benefits: string[];
    citations: unknown;
  }>;

  // Tier 4 — reviews as quotable proof (NEVER as angle source)
  proof_quotes: Array<{ rating: number; quote: string }>;

  // Tier 5 — always-on credibility
  credibility: {
    certifications: string[];
    allergen_free: string[];
    awards: string[];
    review_count: number;
    review_avg: number;
    clinical_study_count: number;
    brand_proof_points: string;
  };

  // Operator-confirmed (Phase 0)
  target_customer: string;
  physical_dimensions: { length_in: number; width_in: number; height_in: number; weight_oz?: number; shape: string } | null;
  variant_isolated_image_url: string | null;
}

export interface ProofAnchor {
  type: "review" | "science" | "award" | "stat";
  value: string;
  source_id?: string;
}

export interface ProductAdAngle {
  id?: string;
  workspace_id?: string;
  product_id: string;
  hook_slug: string;
  lf8_slot: number;
  lead_benefit_anchor: string;
  pain_now: string;
  desired_outcome: string;
  hook_one_liner: string;
  proof_anchor: ProofAnchor;
  urgency_lever: UrgencyLever;
  enemy?: string | null;
  vibe_tags: VibeTag[];
  meta_headline: string;
  meta_primary_text: string;
  meta_description: string;
  generated_by?: "ai" | "agent" | "imported";
}
