import { loadEnv } from "./_bootstrap"; loadEnv();
import { readFileSync } from "fs";
import { parseFunctionMandates } from "../src/lib/function-mandates";
const raw = readFileSync("docs/brain/functions/growth.md", "utf8");
for (const m of parseFunctionMandates(raw)) console.log(m.slug, "  <=  ", m.heading);
