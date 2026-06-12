import { NextResponse } from "next/server";

// TEMPORARY diagnostic — reports what the prod runtime sees for OPENAI_API_KEY
// and whether OpenAI accepts it. Returns only partial key material. Remove after use.
export const dynamic = "force-dynamic";

export async function GET() {
  const raw = process.env.OPENAI_API_KEY ?? null;
  const key = raw?.trim();
  const shape = raw
    ? {
        present: true,
        length: raw.length,
        trimmedLength: key!.length,
        hadWhitespace: raw.length !== key!.length,
        prefix: raw.slice(0, 14),
        suffix: raw.slice(-4),
      }
    : { present: false };

  let models: any = null;
  let whisper: any = null;
  if (key) {
    try {
      const r = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` } });
      const j = await r.json().catch(() => ({}));
      models = { status: r.status, ok: r.ok, error: j?.error?.message?.slice(0, 120) ?? null, count: Array.isArray(j?.data) ? j.data.length : null };
    } catch (e: any) {
      models = { fetchError: String(e?.message || e).slice(0, 120) };
    }
    // also confirm the audio scope specifically (whisper) with an empty multipart — expect 400 (bad request) if authorized, 401 if not
    try {
      const fd = new FormData();
      fd.append("model", "whisper-1");
      const r = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: fd });
      const j = await r.json().catch(() => ({}));
      whisper = { status: r.status, error: j?.error?.message?.slice(0, 120) ?? null, code: j?.error?.code ?? null };
    } catch (e: any) {
      whisper = { fetchError: String(e?.message || e).slice(0, 120) };
    }
  }

  return NextResponse.json({
    deployment: { url: process.env.VERCEL_URL ?? null, commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) ?? null, env: process.env.VERCEL_ENV ?? null },
    openaiKey: shape,
    models,
    whisper,
  });
}
