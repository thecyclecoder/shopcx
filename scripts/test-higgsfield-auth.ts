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

import { getHiggsfieldCredentials, listMotions } from "../src/lib/higgsfield";

async function main() {
  const workspaceId = process.argv[2];
  if (!workspaceId) {
    console.error("Usage: npx tsx scripts/test-higgsfield-auth.ts <workspace_id>");
    process.exit(1);
  }

  const creds = await getHiggsfieldCredentials(workspaceId);
  if (!creds) {
    console.log(`Higgsfield is not connected for workspace ${workspaceId} (no API key/secret stored).`);
    return;
  }
  console.log(`Credentials found — apiKey ...${creds.apiKey.slice(-4)}, secret ...${creds.secret.slice(-4)}`);

  console.log("Fetching motions...");
  const motions = await listMotions(workspaceId);
  console.log(`listMotions returned ${Array.isArray(motions) ? motions.length : 0} item(s):`);
  console.log(JSON.stringify(motions, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
