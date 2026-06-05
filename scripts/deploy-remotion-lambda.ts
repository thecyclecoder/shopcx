/**
 * Provision + deploy Remotion Lambda for production ad rendering.
 *
 * Run once to set up, and again whenever `remotion/` compositions change
 * (deploySite re-uploads the bundle). Idempotent.
 *
 *   npx tsx scripts/deploy-remotion-lambda.ts
 *
 * Requires AWS creds with the Remotion Lambda IAM policy, via env:
 *   REMOTION_AWS_ACCESS_KEY_ID, REMOTION_AWS_SECRET_ACCESS_KEY  (Remotion reads these)
 *   REMOTION_AWS_REGION            (default us-east-1)
 *
 * Prints the env values to set in Vercel + .env.local:
 *   REMOTION_LAMBDA_FUNCTION_NAME, REMOTION_LAMBDA_SERVE_URL, REMOTION_S3_BUCKET
 *
 * See docs/brain/integrations/remotion-lambda.md.
 */
import { readFileSync } from "fs";
import { resolve } from "path";

const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 0) continue;
  const k = t.slice(0, eq);
  if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}

const REGION = (process.env.REMOTION_AWS_REGION || "us-east-1") as any;
const SITE_NAME = process.env.REMOTION_LAMBDA_SITE_NAME || "shopcx-ads";

async function main() {
  if (!process.env.REMOTION_AWS_ACCESS_KEY_ID || !process.env.REMOTION_AWS_SECRET_ACCESS_KEY) {
    throw new Error("Set REMOTION_AWS_ACCESS_KEY_ID + REMOTION_AWS_SECRET_ACCESS_KEY (IAM user with the Remotion Lambda policy) in .env.local first.");
  }
  const { deployFunction, deploySite, getOrCreateBucket } = await import("@remotion/lambda");

  console.log(`region: ${REGION}`);

  // 1. Render function (idempotent — Remotion versions the name; reuses if present).
  console.log("deploying render function…");
  const fn = await deployFunction({
    region: REGION,
    timeoutInSeconds: 240,
    memorySizeInMb: 3008,
    diskSizeInMb: 10240,
    createCloudWatchLogGroup: true,
  });
  console.log(`  ✓ function: ${fn.functionName}`);

  // 2. S3 bucket for sites + render outputs.
  const { bucketName } = await getOrCreateBucket({ region: REGION });
  console.log(`  ✓ bucket: ${bucketName}`);

  // 3. Composition site (re-run on remotion/ changes).
  console.log("deploying composition site (bundling remotion/index.ts)…");
  const site = await deploySite({
    entryPoint: resolve(__dirname, "../remotion/index.ts"),
    bucketName,
    region: REGION,
    siteName: SITE_NAME,
    options: { publicDir: resolve(__dirname, "../remotion/public") },
  });
  console.log(`  ✓ serveUrl: ${site.serveUrl}`);

  console.log("\n— set these in Vercel env + .env.local —");
  console.log(`REMOTION_RENDER_MODE=lambda`);
  console.log(`REMOTION_AWS_REGION=${REGION}`);
  console.log(`REMOTION_LAMBDA_FUNCTION_NAME=${fn.functionName}`);
  console.log(`REMOTION_LAMBDA_SERVE_URL=${site.serveUrl}`);
  console.log(`REMOTION_S3_BUCKET=${bucketName}`);
  console.log("(REMOTION_AWS_ACCESS_KEY_ID + REMOTION_AWS_SECRET_ACCESS_KEY must also be in Vercel)");
}

main().catch((e) => {
  console.error("DEPLOY ERR:", e?.message || e);
  process.exit(1);
});
