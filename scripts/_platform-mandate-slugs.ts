import { loadEnv } from "./_bootstrap"; loadEnv();
import { readFileSync } from "fs";
import { parseFunctionMandates } from "../src/lib/function-mandates";
for (const m of parseFunctionMandates(readFileSync("docs/brain/functions/platform.md","utf8"))) console.log(m.slug,"  <=  ",m.heading);
