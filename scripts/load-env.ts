/**
 * Side-effect module: populate process.env from .env.local.
 *
 * Import this FIRST — before any "@/lib/*" import — in tsx scripts that construct
 * clients which read env at IMPORT time (e.g. the Inngest client does
 * `new Inngest({ id })`, capturing INNGEST_EVENT_KEY when the module evaluates).
 * ES module imports evaluate in source order, so a first-position side-effect
 * import runs before the later lib imports — beating the hoisting trap where a
 * plain top-level env-loading loop runs AFTER the hoisted imports.
 */
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq);
    if (!process.env[k]) process.env[k] = t.slice(eq + 1);
  }
}
