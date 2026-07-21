// spec-test-browser-check — the headless-browser check tool for the box spec-test agent
// (spec-test-deep-verification Phase 1). The companion to scripts/spec-test-db-probe.ts: where db-probe
// gives the read-only DB power, this gives the read-only *browser* power, so a verification bullet that
// asserts RENDERED UI ("the card shows the Agent-tested stamp + chip", "VerificationCard renders per-bullet
// verdicts", "composer textarea ≥5 rows", "a non-owner doesn't see the nav item / gets a 403") becomes a
// BROWSER check (pass/fail + a screenshot as evidence) instead of needs_human.
//
// It launches headless chromium (the box has the browser binary provisioned via
// `npx playwright install --with-deps chromium`), loads a dashboard page authed as the OWNER via a
// SERVER-SIDE minted Supabase session (the service-role admin mints an owner session — NO human creds),
// asserts the rendered DOM / runs read-only interactions, and captures a screenshot it uploads to the
// private `spec-test-evidence` bucket. It prints a JSON verdict to stdout.
//
// 🚨 GUARDRAIL — owner-authed but READ-ONLY on prod. It navigates + asserts + benign clicks
// (expand a section / open a tab) ONLY. It NEVER fills/submits a form that mutates real customer/billing
// data — those bullets stay needs_human (or Phase 2's sandbox). There is no input-typing / form-submit
// capability here by construction.
//
// Usage (from the spec-test skill):
//   npx tsx scripts/spec-test-browser-check.ts --path "/dashboard/developer/spec-tests" \
//     --assert-text "Agent-tested" --assert-selector "[data-test='spec-card']" --slug my-spec --label stamp
//   npx tsx scripts/spec-test-browser-check.ts --path "/dashboard/developer/spec-tests" --role anon \
//     --expect-status 200 --assert-redirect "/login"   # owner-gated page → anon redirected
//
// Prints: { pass, role, url, httpStatus, title, assertions:[...], consoleErrors, screenshot, error }
import { chromium, type Cookie, type ConsoleMessage } from "playwright";
import { errText } from "../src/lib/error-text";
import { createClient } from "@supabase/supabase-js";
import { createChunks, stringToBase64URL } from "@supabase/ssr";
import { createAdminClient } from "./_bootstrap";
import {
  SPEC_TEST_EVIDENCE_BUCKET,
  ensureSpecTestEvidenceBucket,
} from "../src/lib/spec-test-runs";

// The owner whose session we mint. ADMIN_EMAIL in src/lib/supabase/middleware.ts; overridable for tests.
const OWNER_EMAIL = (process.env.SPEC_TEST_OWNER_EMAIL || "dylan@superfoodscompany.com").toLowerCase();
const DEFAULT_BASE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai").replace(/\/$/, "");
const NAV_TIMEOUT_MS = 30_000;

type Args = {
  path: string;
  role: "owner" | "anon";
  baseUrl: string;
  workspaceId?: string;
  expectStatus?: number;
  assertText: string[];
  assertNotText: string[];
  assertSelector: string[];
  assertNoSelector: string[];
  assertRedirect?: string;
  click: string[];
  waitSelector?: string;
  slug: string;
  label: string;
};

// Minimal repeatable-flag parser (no deps). `--flag value` / repeated `--assert-text a --assert-text b`.
function parseArgs(argv: string[]): Args {
  const a: Args = {
    path: "", role: "owner", baseUrl: DEFAULT_BASE_URL,
    assertText: [], assertNotText: [], assertSelector: [], assertNoSelector: [], click: [],
    slug: "misc", label: "check",
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    const next = () => { i++; return v; };
    switch (k) {
      case "--path": a.path = next(); break;
      case "--role": a.role = next() === "anon" ? "anon" : "owner"; break;
      case "--base-url": a.baseUrl = next().replace(/\/$/, ""); break;
      case "--workspace-id": a.workspaceId = next(); break;
      case "--expect-status": a.expectStatus = parseInt(next(), 10); break;
      case "--assert-text": a.assertText.push(next()); break;
      case "--assert-not-text": a.assertNotText.push(next()); break;
      case "--assert-selector": a.assertSelector.push(next()); break;
      case "--assert-no-selector": a.assertNoSelector.push(next()); break;
      case "--assert-redirect": a.assertRedirect = next(); break;
      case "--click": a.click.push(next()); break;
      case "--wait-selector": a.waitSelector = next(); break;
      case "--slug": a.slug = next(); break;
      case "--label": a.label = next(); break;
      default:
        if (k.startsWith("--")) throw new Error(`unknown flag: ${k}`);
    }
  }
  if (!a.path) throw new Error("--path is required (e.g. --path /dashboard/developer/spec-tests)");
  if (!a.path.startsWith("/")) throw new Error("--path must start with '/'");
  return a;
}

/** Supabase project ref from the URL host (sb-<ref>-auth-token is the default supabase-js storage key). */
function projectRef(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set");
  return new URL(url).hostname.split(".")[0];
}

/**
 * Mint the owner's cookies server-side via the service-role admin — NO human credentials. We
 * `generateLink({type:'magiclink'})` to get a token_hash (and the owner's user row), `verifyOtp` it on an
 * anon client to mint a REAL session, then encode it into @supabase/ssr's exact cookie format (the same
 * `base64-` + chunked layout the app's createServerClient reads) plus the `workspace_id` cookie the
 * middleware gate requires. Returns Playwright cookies scoped to the app host.
 */
async function mintOwnerCookies(baseUrl: string, workspaceIdArg?: string): Promise<Cookie[]> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!anonKey) throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY is not set");
  const admin = createAdminClient();

  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: OWNER_EMAIL,
  });
  if (linkErr || !linkData?.properties?.hashed_token) {
    throw new Error(`generateLink failed for ${OWNER_EMAIL}: ${linkErr?.message || "no hashed_token"}`);
  }
  const tokenHash = linkData.properties.hashed_token;
  const ownerUser = linkData.user;

  const anon = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const { data: otp, error: otpErr } = await anon.auth.verifyOtp({ type: "magiclink", token_hash: tokenHash });
  if (otpErr || !otp?.session) {
    throw new Error(`verifyOtp failed: ${otpErr?.message || "no session"}`);
  }
  const session = otp.session;

  // Resolve the workspace the middleware gate requires: explicit arg → owner app_metadata → single membership.
  let workspaceId = workspaceIdArg || (ownerUser?.app_metadata?.workspace_id as string | undefined);
  if (!workspaceId && ownerUser?.id) {
    const { data: memberships } = await admin
      .from("workspace_members")
      .select("workspace_id")
      .eq("user_id", ownerUser.id);
    if (memberships?.length) workspaceId = String(memberships[0].workspace_id);
  }

  const host = new URL(baseUrl).hostname;
  const storageKey = `sb-${projectRef()}-auth-token`;
  const cookieValue = "base64-" + stringToBase64URL(JSON.stringify(session));
  const chunks = createChunks(storageKey, cookieValue); // single {name} or chunked {name.0}.{name.1}…

  const cookies: Cookie[] = chunks.map((c) => ({
    name: c.name, value: c.value, domain: host, path: "/",
    httpOnly: false, secure: true, sameSite: "Lax", expires: -1,
  }));
  if (workspaceId) {
    cookies.push({
      name: "workspace_id", value: workspaceId, domain: host, path: "/",
      httpOnly: false, secure: true, sameSite: "Lax", expires: -1,
    });
  }
  return cookies;
}

type Assertion = { kind: string; target: string; ok: boolean; detail?: string };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targetUrl = `${args.baseUrl}${args.path}`;
  const assertions: Assertion[] = [];
  const consoleErrors: string[] = [];
  let httpStatus = 0;
  let finalUrl = targetUrl;
  let title = "";
  let screenshotPath = "";
  let pass = true;
  let runError: string | null = null;

  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    const cookies = args.role === "owner" ? await mintOwnerCookies(args.baseUrl, args.workspaceId) : [];
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    if (cookies.length) await context.addCookies(cookies);
    const page = await context.newPage();
    page.on("console", (m: ConsoleMessage) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300)); });

    const resp = await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    httpStatus = resp?.status() ?? 0;
    if (args.waitSelector) {
      await page.waitForSelector(args.waitSelector, { timeout: NAV_TIMEOUT_MS }).catch(() => {});
    }
    // Read-only interactions only (expand/tab/open) — never a form submit (see guardrail).
    for (const sel of args.click) {
      await page.click(sel, { timeout: 5_000 }).catch((e: unknown) => {
        assertions.push({ kind: "click", target: sel, ok: false, detail: String(e).slice(0, 160) });
        pass = false;
      });
    }
    await page.waitForTimeout(400); // let any expand/transition settle before asserting/screenshotting
    finalUrl = page.url();
    title = await page.title().catch(() => "");
    const bodyText = await page.evaluate(() => document.body?.innerText || "").catch(() => "");

    if (args.expectStatus != null) {
      const ok = httpStatus === args.expectStatus;
      assertions.push({ kind: "status", target: String(args.expectStatus), ok, detail: `got ${httpStatus}` });
      if (!ok) pass = false;
    }
    if (args.assertRedirect != null) {
      const ok = finalUrl.includes(args.assertRedirect);
      assertions.push({ kind: "redirect", target: args.assertRedirect, ok, detail: `landed on ${finalUrl}` });
      if (!ok) pass = false;
    }
    for (const t of args.assertText) {
      const ok = bodyText.includes(t);
      assertions.push({ kind: "text", target: t, ok });
      if (!ok) pass = false;
    }
    for (const t of args.assertNotText) {
      const ok = !bodyText.includes(t);
      assertions.push({ kind: "not-text", target: t, ok });
      if (!ok) pass = false;
    }
    for (const sel of args.assertSelector) {
      const ok = (await page.locator(sel).count().catch(() => 0)) > 0;
      assertions.push({ kind: "selector", target: sel, ok });
      if (!ok) pass = false;
    }
    for (const sel of args.assertNoSelector) {
      const ok = (await page.locator(sel).count().catch(() => 0)) === 0;
      assertions.push({ kind: "no-selector", target: sel, ok });
      if (!ok) pass = false;
    }

    // Capture a screenshot as evidence (always — a passing render is worth showing too) and upload it to
    // the private evidence bucket. The agent puts the returned path in the check's `screenshot` field.
    const shot = await page.screenshot({ fullPage: true }).catch(() => null);
    if (shot) {
      const safe = (s: string) => s.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 60);
      const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const path = `${safe(args.slug)}/${stamp}-${safe(args.label)}-${args.role}.png`;
      try {
        await ensureSpecTestEvidenceBucket();
        const admin = createAdminClient();
        const { error } = await admin.storage
          .from(SPEC_TEST_EVIDENCE_BUCKET)
          .upload(path, shot, { contentType: "image/png", upsert: true });
        if (!error) screenshotPath = path;
        else consoleErrors.push(`screenshot upload failed: ${error.message}`);
      } catch (e) {
        consoleErrors.push(`screenshot upload threw: ${errText(e)}`);
      }
    }
  } catch (e) {
    runError = errText(e);
    pass = false;
  } finally {
    await browser.close().catch(() => {});
  }

  // No assertions requested but the nav itself succeeded → still useful (renders + reachable).
  if (!assertions.length && !runError && args.expectStatus == null) {
    assertions.push({ kind: "loaded", target: args.path, ok: httpStatus < 400, detail: `HTTP ${httpStatus}` });
    if (httpStatus >= 400) pass = false;
  }

  console.log(JSON.stringify({
    pass: pass && !runError,
    role: args.role,
    url: finalUrl,
    httpStatus,
    title,
    assertions,
    consoleErrors,
    screenshot: screenshotPath || null,
    error: runError,
  }, null, 2));
  if (runError) process.exit(1);
}

main().catch((e) => {
  console.error(JSON.stringify({ pass: false, error: errText(e) }));
  process.exit(1);
});
