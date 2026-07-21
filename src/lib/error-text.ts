/**
 * Lossless renderer for anything a `catch (e)` may hand us.
 *
 * The bug this exists to kill: a PostgREST error returned by supabase-js is a PLAIN OBJECT,
 * not an Error instance. Verified on @supabase/postgrest-js 2.100.0 — the `{ data, error }` error
 * is built as `JSON.parse(body)` / `{ message: body }` / a hand-built literal (dist/index.cjs:130-157);
 * `new PostgrestError(...)` is ONLY constructed when `.throwOnError()` is set. So the hundreds of
 * `if (error) throw error` sites across src/ throw a plain object, and every
 * `e instanceof Error ? e.message : String(e)` catch site rendered it `[object Object]` —
 * destroying the code + message + details + hint at the exact moment we need them.
 *
 * `errText(e)` is the ONE renderer every diagnostic-persisting catch site should call. Rendering
 * order is deliberate — the PostgREST-shaped branch runs BEFORE `instanceof Error` so a real
 * `PostgrestError` from a `.throwOnError()` path (which IS an Error) does not silently drop its
 * `code`/`details`/`hint` fields either.
 */

const MAX_LEN = 2000;

function cap(s: string): string {
  return s.length > MAX_LEN ? s.slice(0, MAX_LEN) : s;
}

export function errText(e: unknown): string {
  if (e === null || e === undefined) return "unknown error";
  if (typeof e === "string") return cap(e);

  // PostgREST-shaped: any object carrying a non-empty string `message`, whether or not it is
  // an Error. Checked BEFORE the plain Error branch so PostgrestError's code/details/hint
  // (present when `.throwOnError()` is used) are rendered, not silently dropped.
  if (typeof e === "object" && typeof (e as { message?: unknown }).message === "string") {
    const obj = e as { message: string; code?: unknown; details?: unknown; hint?: unknown };
    if (obj.message.length > 0) {
      let out = obj.message;
      const code =
        typeof obj.code === "string" && obj.code
          ? obj.code
          : typeof obj.code === "number"
            ? String(obj.code)
            : "";
      const details = typeof obj.details === "string" && obj.details ? obj.details : "";
      const hint = typeof obj.hint === "string" && obj.hint ? obj.hint : "";
      if (code) out += ` [${code}]`;
      if (details) out += ` ${details}`;
      if (hint) out += ` — ${hint}`;
      return cap(out);
    }
  }

  if (e instanceof Error) {
    // Only reached when message is empty (handled above). Prefer stack's first line — it usually
    // carries `Name: message` already — else fall back to the name.
    const name = e.name || "Error";
    const stackFirst =
      typeof e.stack === "string" ? (e.stack.split("\n")[0] ?? "").trim() : "";
    return cap(stackFirst || name);
  }

  if (typeof e === "object") {
    try {
      const s = JSON.stringify(e);
      if (typeof s === "string" && s.length > 0) return cap(s);
    } catch {
      // circular ref — fall through
    }
    return cap(Object.prototype.toString.call(e));
  }

  return cap(String(e));
}
