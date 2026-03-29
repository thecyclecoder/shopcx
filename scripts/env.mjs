// scripts/env.mjs — Load env vars from .env.local for standalone scripts
import { readFileSync } from "fs";
import { resolve } from "path";

const envPath = resolve(import.meta.dirname, "../.env.local");
const lines = readFileSync(envPath, "utf8").split("\n");

for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq < 0) continue;
  const key = trimmed.slice(0, eq);
  const val = trimmed.slice(eq + 1);
  if (!process.env[key]) process.env[key] = val;
}

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
export const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
export const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
export const INNGEST_EVENT_KEY = process.env.INNGEST_EVENT_KEY;
