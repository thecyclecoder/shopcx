/**
 * Shared helpers for the Meta app-review test endpoints. Each
 * endpoint exercises one permission's gating API surface so a
 * Meta reviewer can click "Run test" in our Settings UI and see
 * the real call go through their logs.
 *
 * On any HTTP non-2xx Meta puts the actual error in the body —
 * we surface it verbatim so the reviewer can correlate the
 * fbtrace_id in their tooling.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";

export const META_GRAPH_VERSION = "v21.0";

export interface MetaCreds {
  pageId: string;
  pageToken: string;
  instagramId: string | null;
}

export interface MetaTestCall {
  step: string;
  method: "GET" | "POST" | "DELETE";
  url: string;
  status: number;
  body: unknown;
}

export interface MetaTestResult {
  ok: boolean;
  permission: string;
  summary: string;
  calls: MetaTestCall[];
}

export async function loadMetaCreds(workspaceId: string): Promise<MetaCreds | { error: string }> {
  const admin = createAdminClient();
  const { data: ws } = await admin
    .from("workspaces")
    .select("meta_page_id, meta_page_access_token_encrypted, meta_instagram_id")
    .eq("id", workspaceId)
    .single();
  if (!ws?.meta_page_id || !ws.meta_page_access_token_encrypted) {
    return { error: "Meta page not connected. Connect Facebook first." };
  }
  return {
    pageId: ws.meta_page_id as string,
    pageToken: decrypt(ws.meta_page_access_token_encrypted as string),
    instagramId: (ws.meta_instagram_id as string | null) || null,
  };
}

/**
 * Wrap a fetch + parse + log into a uniform MetaTestCall row.
 */
export async function callMeta(
  step: string,
  method: "GET" | "POST" | "DELETE",
  url: string,
  body?: URLSearchParams,
): Promise<MetaTestCall> {
  const init: RequestInit = { method };
  if (body) {
    init.headers = { "Content-Type": "application/x-www-form-urlencoded" };
    init.body = body.toString();
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* leave as string */ }
  return { step, method, url: url.split("?")[0], status: res.status, body: parsed };
}
