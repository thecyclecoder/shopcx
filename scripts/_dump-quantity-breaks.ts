import "./_bootstrap";
import { writeFileSync } from "fs";

const WS = process.env.WS || "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const { getLiveTheme, readThemeFile } = await import("../src/lib/shopify-theme");
  const live = await getLiveTheme(WS);
  const content = await readThemeFile(live.target, "snippets/quantity-breaks.liquid");
  if (!content) { console.error("NOT FOUND"); process.exit(1); }
  const out = "/private/tmp/claude-501/-Users-admin-Projects-shopcx/157c5e1d-b40b-4bb8-838d-10303624a6a8/scratchpad/quantity-breaks.liquid";
  writeFileSync(out, content);
  console.log("wrote " + out + " (" + content.length + " bytes, " + content.split("\n").length + " lines)");
}
main().catch((e) => { console.error(e); process.exit(1); });
