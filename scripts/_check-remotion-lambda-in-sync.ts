/**
 * Drift check for the deployed Remotion Lambda function vs the pinned
 * `@remotion/lambda` version in `package.json`.
 *
 * ([[../docs/brain/libraries/ad-render.md]] — the runtime guard in `lambdaConfig()`
 * throws `remotion_lambda_version_mismatch` once Inngest handlers hit the broken
 * function in prod. That's the wrong LAYER for a bump-time contract — dep bumps
 * happen in PRs, so the PR is where the paired-deploy check belongs. This mirrors
 * the `check:node-registry-drift` pattern: fail the bumper PR loudly at `predeploy`.)
 *
 * The check fails when:
 *   - `REMOTION_LAMBDA_FUNCTION_NAME` is set AND the `-N-N-N-` version suffix
 *     embedded in the function name does not match the pinned `@remotion/lambda`
 *     version in `package.json` `dependencies`.
 *
 * When `REMOTION_LAMBDA_FUNCTION_NAME` is unset (local dev without Lambda) the
 * check is a green no-op — the same shape `lambdaConfig()` uses.
 *
 * Wired into `npm run predeploy` so a `@remotion/lambda` bump that forgot to
 * re-run `scripts/deploy-remotion-lambda.ts` fails CI red on the bumper PR
 * instead of shipping a landmine into production Inngest handlers.
 *
 * Run manually:  `npx tsx scripts/_check-remotion-lambda-in-sync.ts`
 */
import { readFileSync } from "fs";
import { resolve } from "path";

const REPO_ROOT = resolve(__dirname, "..");
const PACKAGE_JSON_PATH = resolve(REPO_ROOT, "package.json");

function fail(msg: string): never {
  console.error(`\n❌ check-remotion-lambda-in-sync — ${msg}\n`);
  process.exit(1);
}

function readPinnedRemotionLambdaVersion(): string {
  let raw: string;
  try {
    raw = readFileSync(PACKAGE_JSON_PATH, "utf8");
  } catch (e) {
    fail(`could not read ${PACKAGE_JSON_PATH}: ${(e as Error).message}`);
  }
  let pkg: { dependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(raw);
  } catch (e) {
    fail(`could not parse ${PACKAGE_JSON_PATH}: ${(e as Error).message}`);
  }
  const pinned = pkg.dependencies?.["@remotion/lambda"];
  if (!pinned) {
    fail(
      `@remotion/lambda is not listed in package.json dependencies — either the pin was removed ` +
        `(delete this check) or the dep block is malformed.`,
    );
  }
  // Strip leading range prefixes (`^`, `~`, `>=`, etc.) even though the pin should be exact.
  return pinned.replace(/^[~^>=<\s]+/, "").trim();
}

function main(): void {
  const pkgVersion = readPinnedRemotionLambdaVersion();
  const functionName = process.env.REMOTION_LAMBDA_FUNCTION_NAME;

  if (!functionName) {
    console.log(
      `✓ check-remotion-lambda-in-sync — REMOTION_LAMBDA_FUNCTION_NAME unset (local dev / no Lambda), ` +
        `pinned pkg version ${pkgVersion} not compared.`,
    );
    return;
  }

  // Same regex `lambdaConfig()` uses in src/lib/ad-render.ts: the deployed
  // function name carries its Remotion version as a dashed suffix
  // (`remotion-render-4-0-471-mem…`).
  const m = functionName.match(/-(\d+)-(\d+)-(\d+)-/);
  if (!m) {
    fail(
      `REMOTION_LAMBDA_FUNCTION_NAME="${functionName}" does not carry a -N-N-N- version suffix — ` +
        `expected a name shaped like \`remotion-render-4-0-497-mem…\`. Re-run scripts/deploy-remotion-lambda.ts ` +
        `and refresh the Vercel env var.`,
    );
  }
  const fnVersion = `${m[1]}.${m[2]}.${m[3]}`;

  if (fnVersion !== pkgVersion) {
    fail(
      `remotion_lambda_version_mismatch: package.json pins @remotion/lambda=${pkgVersion} but the deployed ` +
        `function name REMOTION_LAMBDA_FUNCTION_NAME="${functionName}" is at ${fnVersion}. ` +
        `Re-run \`npx tsx scripts/deploy-remotion-lambda.ts\` to redeploy the Lambda function AND update ` +
        `the REMOTION_LAMBDA_FUNCTION_NAME + REMOTION_LAMBDA_SERVE_URL Vercel env vars to the values it ` +
        `prints. Otherwise every Inngest ad-render handler will throw remotion_lambda_version_mismatch in prod.`,
    );
  }

  console.log(
    `✓ check-remotion-lambda-in-sync — pkg=${pkgVersion} matches deployed function ${functionName}.`,
  );
}

main();
