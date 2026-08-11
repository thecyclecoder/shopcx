/**
 * Static-analysis check: a read/write keyed on an EXTERNAL id must also be scoped by `workspace_id`.
 *
 * THE BUG CLASS. Identifiers minted by external systems — `shopify_contract_id`, `shopify_order_id`,
 * `shopify_customer_id`, `appstle_subscription_id`, `stripe_customer_id`, … — are NOT globally unique
 * across our tenants. Two workspaces can legitimately hold rows carrying the same value (a shared or
 * duplicated storefront, a re-imported contract, a test tenant seeded from production data). A query
 * filtered on one of those alone therefore addresses "some row in some workspace", not "this tenant's
 * row" — so a SELECT can read another tenant's data and an UPDATE/DELETE can overwrite it.
 *
 * THE INCIDENT (2026-08-10 → 2026-08-11). `subscription-items.ts` `syncItemsAfterMutation` selected
 * AND updated `subscriptions` filtered only by `shopify_contract_id`, while `workspaceId` was already
 * a parameter and used on the adjacent line. An ordinary AI-driven swap/add/remove could therefore
 * write one tenant's items array onto another tenant's subscription. The pre-merge security review
 * FOUND it, but the finding was routed into a standalone fix spec by the (since-retired) fix-spec
 * model and was discarded when that spec was cleaned up as a model artifact. It survived on main for
 * a day with no error, no test failure, and no alert.
 *
 * ADMISSION CRITERION ([[../docs/brain/operational-rules]] § Predeploy static guards): a violation
 * produces NO error anyone would see — the query succeeds, returns/writes a row, and is simply the
 * WRONG tenant's row. Exactly the silent class this chain exists for.
 *
 * WHAT IT SCANS. `src/lib/**` and `src/app/**` for a Supabase chain that filters on one of the
 * EXTERNAL_ID_COLUMNS and reaches a `.select(`/`.update(`/`.delete(`/`.upsert(` without an
 * `.eq("workspace_id"` anywhere in the same chain. Chain = the text from `.from(` to the terminating
 * `;`, which is how every call in this codebase is written.
 *
 * ESCAPE HATCH. A genuinely global lookup (a webhook resolving which workspace an event belongs to,
 * before any workspace is known) is legitimate — annotate that line or the line above it with
 *   // tenant-scope-exempt: <reason>
 * and the guard skips it. The reason is mandatory; a bare marker does not count.
 *
 *   Run:    npx tsx scripts/_check-tenant-scoped-external-id-writes.ts
 *   Wired:  `npm run check:tenant-scoped-external-id-writes` → chained into `predeploy:static`.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

const REPO_ROOT = join(__dirname, "..");
const SCAN_DIRS = ["src/lib", "src/app"];

/** External identifiers that are NOT unique across tenants. */
const EXTERNAL_ID_COLUMNS = [
  "shopify_contract_id",
  "shopify_order_id",
  "shopify_customer_id",
  "shopify_product_id",
  "shopify_variant_id",
  "appstle_subscription_id",
  "stripe_customer_id",
  "braintree_customer_id",
];

const EXEMPT_MARKER = /tenant-scope-exempt:\s*\S+/;

interface Violation {
  file: string;
  line: number;
  column: string;
  op: string;
  snippet: string;
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (e === "node_modules" || e.startsWith(".")) continue;
      walk(p, out);
    } else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) {
      out.push(p);
    }
  }
  return out;
}

function main() {
  const violations: Violation[] = [];

  for (const dir of SCAN_DIRS) {
    for (const file of walk(join(REPO_ROOT, dir))) {
      const src = readFileSync(file, "utf8");
      const lines = src.split("\n");

      // Split into Supabase chains: `.from(` … up to the terminating `;`.
      const chainRe = /\.from\(\s*["'`]([a-z_]+)["'`]\s*\)[\s\S]*?;/g;
      let m: RegExpExecArray | null;
      while ((m = chainRe.exec(src)) !== null) {
        const chain = m[0];
        const startLine = src.slice(0, m.index).split("\n").length;

        const extCol = EXTERNAL_ID_COLUMNS.find((c) => new RegExp(`\\.eq\\(\\s*["'\`]${c}["'\`]`).test(chain));
        if (!extCol) continue;
        if (/\.eq\(\s*["'`]workspace_id["'`]/.test(chain)) continue; // properly scoped inline

        // SCOPE-WRAPPER AWARENESS. A chain passed into a `scopeXxx(...)` helper is scoped by that helper,
        // not inline — e.g. `scopeSub(admin.from("subscriptions").select(...).eq("shopify_contract_id", id))`
        // where `scopeSub` appends `.eq("workspace_id", ctx.workspaceId)` (and `customer_id`). Treating those
        // as violations is a FALSE POSITIVE, and "fixing" them would double-apply the filter or, worse,
        // invite an edit that removes the wrapper. Detect by looking immediately left of `.from(` for an
        // open `scope…(` call.
        const before = src.slice(Math.max(0, m.index - 60), m.index);
        // `before` ends just left of the `.` in `.from(` — e.g. `const q = scopeSub(admin`.
        if (/\bscope\w*\(\s*\w*$/.test(before)) continue;

        const op = /\.update\(/.test(chain)
          ? "update"
          : /\.delete\(/.test(chain)
            ? "delete"
            : /\.upsert\(/.test(chain)
              ? "upsert"
              : /\.select\(/.test(chain)
                ? "select"
                : "";
        if (!op) continue;

        // Exemption: the marker anywhere in the comment block immediately above the chain (a real
        // justification runs several lines), or inside the chain itself. Scan up from the chain's first
        // line while the lines are comments/blank; stop at the first line of actual code so a marker
        // belonging to an UNRELATED earlier statement can never leak an exemption onto this one.
        let exempt = EXEMPT_MARKER.test(chain);
        for (let i = startLine - 2; i >= 0 && !exempt; i--) {
          const t = (lines[i] ?? "").trim();
          if (t === "") continue;
          if (!t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*")) break; // hit real code
          if (EXEMPT_MARKER.test(t)) exempt = true;
        }
        if (exempt) continue;

        violations.push({
          file: relative(REPO_ROOT, file),
          line: startLine,
          column: extCol,
          op,
          snippet: chain.replace(/\s+/g, " ").slice(0, 150),
        });
      }
    }
  }

  if (violations.length === 0) {
    console.log(`✅ check-tenant-scoped-external-id-writes — every external-id query is workspace-scoped`);
    return;
  }

  console.error(`❌ check-tenant-scoped-external-id-writes — ${violations.length} query(ies) keyed on an external id without workspace_id:\n`);
  for (const v of violations) {
    console.error(`  • ${v.file}:${v.line}  [${v.op}]  .eq("${v.column}") with no .eq("workspace_id")`);
    console.error(`      ${v.snippet}\n`);
  }
  console.error(
    `An external id (shopify_contract_id, shopify_order_id, …) is NOT unique across tenants — two workspaces\n` +
      `can hold rows with the same value. Filtering on it alone addresses "some row in some workspace": a select\n` +
      `can READ another tenant's data and an update/delete can OVERWRITE it, silently.\n\n` +
      `FIX: add .eq("workspace_id", workspaceId) to the chain.\n` +
      `If the lookup is genuinely global (e.g. a webhook resolving which workspace an event belongs to, before\n` +
      `any workspace is known), annotate it:  // tenant-scope-exempt: <why this must be global>\n\n` +
      `Ground truth: subscription-items.ts syncItemsAfterMutation (2026-08-10) — a cross-tenant items write\n` +
      `reachable from an ordinary AI swap/add/remove. Found by security review, lost with a deferred fix spec.`,
  );
  process.exit(1);
}

main();
