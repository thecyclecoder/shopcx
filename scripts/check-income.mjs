import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "/Users/admin/Projects/shopcx/scripts/env.mjs";
const s = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const ws = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

// Distribution of zip_income_bracket across enriched rows
const PAGE = 1000;
let from = 0;
const counts = {};
let totalRows = 0;
let withIncomeBracket = 0;
let withMedianIncome = 0;
let withZip = 0;
const sampleRows = [];

while (true) {
  const { data, error } = await s.from("customer_demographics")
    .select("zip_code, zip_median_income, zip_income_bracket, zip_urban_classification")
    .eq("workspace_id", ws)
    .range(from, from + PAGE - 1);
  if (error) { console.error(error); break; }
  if (!data || data.length === 0) break;
  for (const r of data) {
    totalRows++;
    if (r.zip_code) withZip++;
    if (r.zip_median_income != null) withMedianIncome++;
    if (r.zip_income_bracket) withIncomeBracket++;
    counts[r.zip_income_bracket || "NULL"] = (counts[r.zip_income_bracket || "NULL"] || 0) + 1;
    if (sampleRows.length < 5 && r.zip_median_income != null) sampleRows.push(r);
  }
  if (data.length < PAGE) break;
  from += PAGE;
}
console.log(`Total rows: ${totalRows}`);
console.log(`With zip_code: ${withZip}`);
console.log(`With zip_median_income (numeric): ${withMedianIncome}`);
console.log(`With zip_income_bracket: ${withIncomeBracket}`);
console.log(`Distribution:`, counts);
console.log(`\nSample rows that have median_income:`);
for (const r of sampleRows) console.log(` `, r);
