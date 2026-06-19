/**
 * Slack List mirror of the roadmap (slack-roadmap-home Phase 3) — a native Slack List that mirrors
 * docs/brain/specs/*.md as a PM table: one row per spec (Spec title · Status · Owner · Phases · Slug).
 *
 * READ-ONLY MIRROR. The brain stays the source of truth ([[brain-roadmap]] getRoadmap) — this only
 * reconciles the List to match (create / update / delete rows). The List NEVER drives builds; that's
 * the App Home tab ([[slack-home]]). Sync is best-effort and never throws, so a Lists API failure
 * can't break the Home view or a queued build — it just leaves the List stale until the next sync.
 *
 * The List is created once per workspace by the bot; its handle (file id + the generated column ids)
 * is cached on workspaces.slack_roadmap_list so later syncs reconcile the SAME List. Diff key = the
 * spec slug (its own column). Steady state = one items.list read + zero writes.
 *
 * Requires bot scopes lists:read + lists:write (one-time owner config on the Slack app). With those
 * scopes absent the create/list calls fail and sync no-ops — the Home tab is unaffected.
 *
 * See docs/brain/libraries/slack-list.md.
 */
import { getRoadmap, functionLabel, type SpecCard, type Phase } from "@/lib/brain-roadmap";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getSlackToken,
  createSlackList,
  listSlackListItems,
  createSlackListItem,
  updateSlackListItem,
  deleteSlackListItem,
  slackListCell,
  type SlackListColumn,
  type SlackListSchemaCol,
  type SlackListItem,
} from "@/lib/slack";

const LIST_NAME = "🗺️ ShopCX Roadmap";

// The mirror schema. `key` is our stable handle; Slack returns a generated column id per key that we
// must address cells by (cached in workspaces.slack_roadmap_list.cols). Order = column order.
const COLUMNS: SlackListColumn[] = [
  { key: "spec", name: "Spec", type: "text", is_primary_column: true },
  { key: "status", name: "Status", type: "text" },
  { key: "owner", name: "Owner", type: "text" },
  { key: "phases", name: "Phases", type: "number" },
  { key: "slug", name: "Slug", type: "text" },
];

const STATUS_LABEL: Record<Phase, string> = {
  planned: "⏳ Planned",
  in_progress: "🚧 In progress",
  shipped: "✅ Shipped",
  rejected: "❌ Rejected",
};

interface ListHandle {
  id: string;
  cols: Record<string, string>; // schema key → generated column id
}

type ColMap = Record<string, string>;

/** Desired cell values for a spec, keyed by schema key. The brain row this List must match. */
function desired(spec: SpecCard): Record<string, string | number> {
  return {
    spec: spec.title,
    status: STATUS_LABEL[spec.status],
    owner: spec.owner ? functionLabel(spec.owner) : "—",
    phases: spec.phases.length,
    slug: spec.slug,
  };
}

/** Map our schema keys → Slack's generated column ids from a create response (match by key, then name). */
function colMapFromSchema(schema: SlackListSchemaCol[]): ColMap {
  const map: ColMap = {};
  for (const col of COLUMNS) {
    const hit = schema.find((s) => s.key === col.key || s.name === col.name);
    const id = hit?.id || hit?.column_id || hit?.key;
    if (id) map[col.key] = id;
  }
  return map;
}

/** Read a row's cell as plain text (text cells expose `text`; number cells expose `value`). */
function cellText(item: SlackListItem, columnId: string | undefined): string {
  if (!columnId) return "";
  const f = item.fields?.find((x) => x.column_id === columnId);
  if (!f) return "";
  if (typeof f.text === "string") return f.text;
  if (f.value != null) return String(f.value);
  return "";
}

/** Build the create/update cell payloads for a spec, encoding each by its column type. */
function buildCells(cols: ColMap, want: Record<string, string | number>): Record<string, unknown>[] {
  const cells: Record<string, unknown>[] = [];
  for (const col of COLUMNS) {
    const v = want[col.key];
    if (v === undefined) continue;
    const columnId = cols[col.key];
    if (!columnId) continue;
    cells.push(slackListCell(columnId, col.type, v));
  }
  return cells;
}

/** True if any cell on the existing row differs from what the brain now says — gates updates. */
function rowDrifted(item: SlackListItem, cols: ColMap, want: Record<string, string | number>): boolean {
  for (const col of COLUMNS) {
    const v = want[col.key];
    if (v === undefined) continue;
    if (String(v) !== cellText(item, cols[col.key])) return true;
  }
  return false;
}

async function readHandle(workspaceId: string): Promise<ListHandle | null> {
  const admin = createAdminClient();
  const { data } = await admin.from("workspaces").select("slack_roadmap_list").eq("id", workspaceId).single();
  const h = data?.slack_roadmap_list as ListHandle | null | undefined;
  return h && h.id && h.cols ? h : null;
}

async function saveHandle(workspaceId: string, handle: ListHandle): Promise<void> {
  const admin = createAdminClient();
  await admin.from("workspaces").update({ slack_roadmap_list: handle }).eq("id", workspaceId);
}

export interface SyncResult {
  ok: boolean;
  created?: number;
  updated?: number;
  deleted?: number;
  error?: string;
}

/**
 * Reconcile the workspace's Slack List to the current brain roadmap. Creates the List on first run
 * (caching its handle), then create/update/delete rows so the List == getRoadmap(). Best-effort and
 * non-throwing: any failure returns { ok:false } and leaves the List as-is.
 */
export async function syncRoadmapList(workspaceId: string): Promise<SyncResult> {
  try {
    const token = await getSlackToken(workspaceId);
    if (!token) return { ok: false, error: "no_token" };

    const { specs } = await getRoadmap();

    let handle = await readHandle(workspaceId);
    if (!handle) {
      const created = await createSlackList(token, LIST_NAME, COLUMNS);
      if (!created) return { ok: false, error: "create_failed" };
      handle = { id: created.listId, cols: colMapFromSchema(created.schema) };
      await saveHandle(workspaceId, handle);
    }
    const { id: listId, cols } = handle;
    if (!Object.keys(cols).length) return { ok: false, error: "no_columns" };

    const items = await listSlackListItems(token, listId);
    const slugCol = cols.slug;
    const bySlug = new Map<string, SlackListItem>();
    for (const it of items) {
      const slug = cellText(it, slugCol);
      if (slug) bySlug.set(slug, it);
    }

    let created = 0;
    let updated = 0;
    let deleted = 0;
    const wantSlugs = new Set(specs.map((s) => s.slug));

    for (const spec of specs) {
      const want = desired(spec);
      const existing = bySlug.get(spec.slug);
      if (!existing) {
        if (await createSlackListItem(token, listId, buildCells(cols, want))) created++;
      } else if (rowDrifted(existing, cols, want)) {
        if (await updateSlackListItem(token, listId, existing.id, buildCells(cols, want))) updated++;
      }
    }

    // Drop rows whose slug no longer maps to a spec (renamed / archived) — the brain is canonical.
    for (const [slug, it] of bySlug) {
      if (!wantSlugs.has(slug)) {
        if (await deleteSlackListItem(token, listId, it.id)) deleted++;
      }
    }

    return { ok: true, created, updated, deleted };
  } catch (e) {
    console.error("[slack-list] syncRoadmapList failed:", e);
    return { ok: false, error: e instanceof Error ? e.message : "unknown" };
  }
}
