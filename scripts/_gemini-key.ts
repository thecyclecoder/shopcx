import { loadEnv } from "./_bootstrap"; loadEnv();
import { getGeminiCredentials } from "../src/lib/gemini";
(async () => {
  const c = await getGeminiCredentials("fdc11e10-b89f-4989-8b73-ed6526c4d906").catch(()=>null);
  console.log("gemini key available:", c?.apiKey ? "YES ("+c.apiKey.slice(0,6)+"…)" : "NO");
  process.exit(0);
})();
