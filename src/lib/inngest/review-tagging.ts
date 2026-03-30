// Inngest functions for tagging product reviews with cancel-relevance
// Uses Claude Haiku to analyze which cancel reasons each review helps counter

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";

const CANCEL_REASONS = [
  "too_expensive",
  "too_much_product",
  "not_seeing_results",
  "reached_goals",
  "just_need_a_break",
  "tired_of_flavor",
  "shipping_issues",
  "something_else",
];

const BATCH_SIZE = 20;

async function tagReview(
  review: { id: string; title: string | null; body: string | null; summary: string | null; rating: number },
): Promise<string[]> {
  const reviewText = [review.title, review.summary, review.body].filter(Boolean).join("\n\n");
  if (!reviewText || reviewText.length < 20) return [];

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return [];

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [{
        role: "user",
        content: `You analyze product reviews for a subscription company. Given this review, determine which cancel reasons it would help counter. A customer considering cancelling for a given reason would be encouraged to stay after reading this review.

Cancel reasons: ${CANCEL_REASONS.join(", ")}

Review (${review.rating}/5 stars):
${reviewText}

Return ONLY a JSON array of matching cancel reason slugs. Only include reasons where the review is clearly relevant and compelling. If the review is too generic or doesn't clearly address any reason, return an empty array [].`,
      }],
    }),
  });

  if (!res.ok) return [];
  const data = await res.json();
  const text = data?.content?.[0]?.text || "";

  try {
    const match = text.match(/\[[\s\S]*?\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s: unknown) => typeof s === "string" && CANCEL_REASONS.includes(s as string));
  } catch {
    return [];
  }
}

/**
 * Bulk tag — manually triggered, processes all reviews where cancel_relevance IS NULL
 */
export const tagCancelRelevanceBulk = inngest.createFunction(
  {
    id: "reviews/tag-cancel-relevance",
    concurrency: { limit: 1 },
    triggers: [{ event: "reviews/tag-cancel-relevance" }],
  },
  async ({ step }: { event: any; step: any }) => {
    const admin = createAdminClient();

    const { count } = await step.run("count-untagged", async () => {
      const result = await admin.from("product_reviews")
        .select("id", { count: "exact", head: true })
        .is("cancel_relevance", null)
        .gte("rating", 3);
      return { count: result.count || 0 };
    });

    if (!count) return { tagged: 0 };

    const batches = Math.ceil(count / BATCH_SIZE);
    let totalTagged = 0;

    for (let batch = 0; batch < batches; batch++) {
      const result = await step.run(`tag-batch-${batch}`, async () => {
        const { data: reviews } = await admin.from("product_reviews")
          .select("id, title, body, summary, rating")
          .is("cancel_relevance", null)
          .gte("rating", 3)
          .order("created_at", { ascending: false })
          .limit(BATCH_SIZE);

        if (!reviews?.length) return { tagged: 0 };

        let tagged = 0;
        for (const review of reviews) {
          const relevance = await tagReview(review);
          await admin.from("product_reviews")
            .update({
              cancel_relevance: relevance.length > 0 ? relevance : [],
              cancel_relevance_at: new Date().toISOString(),
            })
            .eq("id", review.id);
          if (relevance.length > 0) tagged++;
        }

        return { tagged };
      });

      totalTagged += result.tagged;
    }

    return { tagged: totalTagged, total: count };
  },
);

/**
 * Weekly cron — processes new reviews and any stragglers
 */
export const tagCancelRelevanceCron = inngest.createFunction(
  {
    id: "reviews/tag-cancel-relevance-cron",
    concurrency: { limit: 1 },
    triggers: [{ cron: "0 4 * * 1" }], // Monday at 4am
  },
  async ({ step }: { event: any; step: any }) => {
    const admin = createAdminClient();

    const reviews = await step.run("fetch-reviews", async () => {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

      const { data } = await admin.from("product_reviews")
        .select("id, title, body, summary, rating")
        .gte("rating", 3)
        .or(`cancel_relevance.is.null,created_at.gte.${sevenDaysAgo}`)
        .order("created_at", { ascending: false })
        .limit(100);

      return data || [];
    });

    if (!reviews.length) return { tagged: 0 };

    const reviewBatches: typeof reviews[] = [];
    for (let i = 0; i < reviews.length; i += BATCH_SIZE) {
      reviewBatches.push(reviews.slice(i, i + BATCH_SIZE));
    }

    let totalTagged = 0;

    for (let b = 0; b < reviewBatches.length; b++) {
      const batch = reviewBatches[b];
      const result = await step.run(`cron-batch-${b}`, async () => {
        let tagged = 0;
        for (const review of batch) {
          const relevance = await tagReview(review);
          await admin.from("product_reviews")
            .update({
              cancel_relevance: relevance.length > 0 ? relevance : [],
              cancel_relevance_at: new Date().toISOString(),
            })
            .eq("id", review.id);
          if (relevance.length > 0) tagged++;
        }
        return { tagged };
      });

      totalTagged += result.tagged;
    }

    return { tagged: totalTagged, total: reviews.length };
  },
);
