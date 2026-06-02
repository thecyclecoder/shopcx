/**
 * Hit Braintree's customer.search API by email for both Dylan
 * addresses and report what's already in the vault.
 */
import { readFileSync } from "fs";
import { resolve } from "path";

function loadEnv(path: string) {
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("="); if (eq < 0) continue;
    const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
  }
}
loadEnv(resolve(process.cwd(), ".env.local"));

const SUPERFOODS_WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const EMAILS = ["dylan@superfoodscompany.com", "dylanralston@gmail.com"];

async function main() {
  const { getBraintreeGateway } = await import("../src/lib/integrations/braintree");
  const gateway = await getBraintreeGateway(SUPERFOODS_WORKSPACE_ID);

  for (const email of EMAILS) {
    console.log(`\n── ${email} ──`);
    const matches: Array<{
      id: string;
      firstName?: string;
      lastName?: string;
      email?: string;
      phone?: string;
      createdAt?: string;
      paymentMethods?: Array<{ token: string; cardType?: string; last4?: string; expirationDate?: string; default?: boolean }>;
    }> = [];
    await new Promise<void>((resolveP, rejectP) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stream: any = gateway.customer.search((s: any) => { s.email().is(email); });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stream.on("data", (c: any) => {
        const pms = (c.paymentMethods || c.creditCards || []).map((pm: { token: string; cardType?: string; last4?: string; expirationDate?: string; default?: boolean }) => ({
          token: pm.token,
          cardType: pm.cardType,
          last4: pm.last4,
          expirationDate: pm.expirationDate,
          default: pm.default,
        }));
        matches.push({
          id: c.id,
          firstName: c.firstName,
          lastName: c.lastName,
          email: c.email,
          phone: c.phone,
          createdAt: c.createdAt,
          paymentMethods: pms,
        });
      });
      stream.on("end", resolveP);
      stream.on("error", rejectP);
    });

    if (matches.length === 0) {
      console.log("  (no Braintree customer found)");
      continue;
    }
    for (const m of matches) {
      console.log(`  id=${m.id}`);
      console.log(`    name: ${[m.firstName, m.lastName].filter(Boolean).join(" ") || "(unset)"}`);
      console.log(`    email: ${m.email}`);
      console.log(`    phone: ${m.phone || "(unset)"}`);
      console.log(`    createdAt: ${m.createdAt}`);
      console.log(`    payment methods: ${m.paymentMethods?.length || 0}`);
      for (const pm of m.paymentMethods || []) {
        console.log(`      • ${pm.cardType || "?"} ending ${pm.last4 || "????"} exp ${pm.expirationDate || "?"}${pm.default ? " (default)" : ""}  token=${pm.token}`);
      }
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
