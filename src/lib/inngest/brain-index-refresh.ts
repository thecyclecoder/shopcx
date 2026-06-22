/**
 * brain-index-refresh — the SINGLE writer that keeps the two aggregate brain files fresh out-of-band.
 *
 * Folds no longer commit `docs/brain/archive.md` (the human-readable Index) or `docs/brain/README.md`
 * folder counts — they only write the per-spec `docs/brain/archive.d/{slug}.md`. The board is always
 * correct (`getArchive` reads archive.d/), but those two aggregates drift in the repo. This cron is the
 * one place that regenerates and commits them, so no fold PR ever contends on them again
 * (single writer, not N folds). See docs/brain/specs/brain-index-refresh.md.
 *
 * Reads the bundled `docs/brain/` tree (traced into the /api/inngest bundle in next.config.ts),
 * regenerates via `regenerateBrainIndex`, then commits ONLY a real diff to `main` via the GitHub
 * Contents API — the same path the authoring chat uses. A no-op when nothing changed (no empty/loop
 * commits): the commit changes the file to exactly what regen produces, so the next run sees no diff.
 *
 * Triggers: daily cron + a `brain/index.refresh` event sent right after a `claude/fold-*` PR merges
 * (near-real-time freshness; still a single writer).
 */
import { inngest } from "./client";
import { regenerateBrainIndex, type RegenFile } from "@/lib/brain-index";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";
import path from "path";

const REPO = process.env.AGENT_TODO_REPO || "thecyclecoder/shopcx";

function ghToken(): string | undefined {
  return process.env.GITHUB_TOKEN || process.env.AGENT_TODO_GITHUB_TOKEN;
}

async function gh(
  method: string,
  apiPath: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const res = await fetch(`https://api.github.com${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${ghToken()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, json: text ? JSON.parse(text) : {} };
}

/** Commit one regenerated file to `main` only if it differs from what's there now. Returns whether it
 *  committed. The diff is taken against the LIVE main content (not the bundle) so this is the no-op /
 *  no-loop guard: a chore commit makes main equal to regen output, so the next run finds no diff. */
async function commitIfChanged(file: RegenFile): Promise<{ path: string; committed: boolean; reason?: string }> {
  const get = await gh("GET", `/repos/${REPO}/contents/${file.path}?ref=main`);
  if (!get.ok) return { path: file.path, committed: false, reason: `GET failed (${get.status})` };

  const sha = get.json.sha as string | undefined;
  const currentContent = Buffer.from(String(get.json.content || "").replace(/\s/g, ""), "base64").toString("utf8");
  if (currentContent === file.content) return { path: file.path, committed: false, reason: "already current" };

  const put = await gh("PUT", `/repos/${REPO}/contents/${file.path}`, {
    message: "chore: refresh brain index",
    content: Buffer.from(file.content, "utf8").toString("base64"),
    sha,
    branch: "main",
  });
  if (!put.ok) return { path: file.path, committed: false, reason: `PUT failed (${put.status})` };
  return { path: file.path, committed: true };
}

export const brainIndexRefresh = inngest.createFunction(
  { id: "brain-index-refresh", retries: 1, triggers: [{ cron: "0 9 * * *" }, { event: "brain/index.refresh" }] },
  async ({ step }) => {
    if (!ghToken()) return { skipped: "GitHub not configured" };

    // Regenerate from the bundled docs/brain/ tree (reflects main as of the last deploy; a merged fold
    // redeploys, so the daily run sees the latest archive.d/).
    const brainDir = path.join(process.cwd(), "docs", "brain");
    const { archive, readme } = regenerateBrainIndex(brainDir);

    const results: { path: string; committed: boolean; reason?: string }[] = [];
    for (const file of [archive, readme]) {
      if (!file) continue;
      // One step per file: each Contents API commit is independently retryable.
      const r = await step.run(`commit-${path.basename(file.path)}`, () => commitIfChanged(file));
      results.push(r);
    }

    const result = { committed: results.filter((r) => r.committed).map((r) => r.path), results };

    // Control Tower: end-of-run heartbeat (control-tower-complete-coverage spec, Phase 1).
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("brain-index-refresh", { ok: true, produced: result });
    });

    return result;
  },
);
