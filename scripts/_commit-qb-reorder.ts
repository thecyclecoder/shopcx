import "./_bootstrap";
import { readFileSync } from "fs";

const WS = process.env.WS || "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SP = "/private/tmp/claude-501/-Users-admin-Projects-shopcx/157c5e1d-b40b-4bb8-838d-10303624a6a8/scratchpad";

async function main() {
  const { getLiveTheme, commitThemeFiles, verifyDeployed } = await import("../src/lib/shopify-theme");
  const live = await getLiveTheme(WS);
  console.log(`theme: ${live.name}  repo: ${live.target.owner}/${live.target.repo}@${live.target.branch}`);

  const changes = [
    { path: "snippets/quantity-breaks.liquid", content: readFileSync(`${SP}/quantity-breaks.liquid`, "utf8") },
    { path: "assets/quantity-breaks.css", content: readFileSync(`${SP}/quantity-breaks.css`, "utf8") },
  ];

  const message =
    "PDP quantity breaks: invert card order to 90 -> 60 -> 30 (3-pack decoy anchor)\n\n" +
    "Reorders the three price cards so the 90-day (highest total) renders first as the " +
    "price anchor, making the 60/30-day feel more affordable. 90-day gets a green " +
    "'Best value - lowest price per serving' badge; the 60-day (2-pack) stays the " +
    "pre-checked default + 'Most popular'. Cards were hardcoded blocks (not loop-driven), " +
    "so the order was moved in markup; radios key off value + data-qty so JS is unchanged. " +
    "Pick-Your-Flavors customizer loop left as 1,2,3.";

  const commit = await commitThemeFiles(live.target, changes, message);
  console.log(`committed -> ${commit.commitSha}`);
  console.log(commit.url);

  console.log("polling verifyDeployed...");
  const expected = changes.map((c) => ({ path: c.path, content: c.content }));
  for (let attempt = 1; attempt <= 12; attempt++) {
    await new Promise((r) => setTimeout(r, 5000));
    const rows = await verifyDeployed(WS, expected);
    const ok = rows.filter((r) => r.ok).length;
    console.log(`attempt ${attempt}/12 - ${ok}/${rows.length} files match live`);
    if (rows.every((r) => r.ok)) {
      console.log("LIVE - quantity breaks now render 90 -> 60 -> 30 on the Superfoods PDP.");
      return;
    }
  }
  console.log("commit landed but Shopify has not re-pulled after ~60s. Check the Shopify -> GitHub integration.");
}

main().catch((e) => { console.error(e); process.exit(1); });
