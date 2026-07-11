import { createAdminClient } from "./_bootstrap";
import { qboFetch } from "../src/lib/quickbooks";

// Known supply-chain partners for the tabs line (+ the other manufacturers that appear in the
// measured lead times), classified by kind. qb_vendor_id links to live measured lead times.
const PARTNERS: Array<{ name: string; kind: string; notes?: string }> = [
  { name: "VitaQuest", kind: "manufacturer", notes: "Finished Superfood Tabs (SL, Mixed Berry, Peach Mango) + Ashwavana. Long lead (~3-5mo); under-produces ~5-28%." },
  { name: "Gemini Pharmaceuticals", kind: "manufacturer", notes: "Amazing Creamer / Coffee / Creatine Prime finished goods." },
  { name: "NoltPak LLC", kind: "manufacturer", notes: "Coffee K-Cups + Pods." },
  { name: "Beyer Graphics", kind: "component", notes: "IFC inserts / boxes for the tabs line." },
  { name: "Overnight Labels, Inc.", kind: "component", notes: "Gussets, stick packs, labels." },
  { name: "Amplifier", kind: "3pl", notes: "3PL — fulfills the Shopify storefront + internal/subscriber orders. NOT Amazon (that's FBA)." },
];

(async () => {
  const admin = createAdminClient();
  const { data: ws } = await admin.from("workspaces").select("id").not("shopify_access_token_encrypted","is",null);
  const wsId = ws![0].id;

  // name -> QB Vendor.Id
  const d = await qboFetch(wsId, "query", { query: { query: `SELECT * FROM Vendor MAXRESULTS 1000` }, admin });
  const vid = new Map<string,string>();
  for (const v of (d?.QueryResponse?.Vendor ?? []) as any[]) vid.set(v.DisplayName, v.Id);

  for (const p of PARTNERS) {
    const qbVendorId = vid.get(p.name) ?? null;
    const { error } = await admin.from("suppliers").upsert({
      workspace_id: wsId, name: p.name, qb_vendor_id: qbVendorId, kind: p.kind, notes: p.notes ?? null,
      active: true, updated_at: new Date().toISOString(),
    }, { onConflict: "workspace_id,name" });
    console.log(`  ${error ? "ERR "+error.message : "ok"}  ${p.name} (${p.kind}) qb_vendor_id=${qbVendorId}`);
  }

  // Confirmed crisis-PO ETA (founder-provided): Mixed Berry 30ct PO id=116193 arrives 2026-07-29.
  const { data: vq } = await admin.from("suppliers").select("id").eq("workspace_id", wsId).eq("name","VitaQuest").single();
  const { error: aerr } = await admin.from("purchase_order_annotations").upsert({
    workspace_id: wsId, qb_po_id: "116193", supplier_id: vq?.id ?? null,
    expected_arrival_date: "2026-07-29", eta_status: "confirmed",
    note: "Mixed Berry crisis PO — confirmed arrival per founder (measured lead would estimate ~June; it is delayed).",
    updated_at: new Date().toISOString(),
  }, { onConflict: "workspace_id,qb_po_id" });
  console.log(`\n  ${aerr ? "ERR "+aerr.message : "ok"}  PO#1274 (116193) MB-30 ETA 2026-07-29 confirmed`);

  // Verify
  const { data: sup } = await admin.from("suppliers").select("name, kind, qb_vendor_id").eq("workspace_id", wsId).order("name");
  console.log("\nsuppliers:", sup);
  const { data: ann } = await admin.from("purchase_order_annotations").select("qb_po_id, expected_arrival_date, eta_status").eq("workspace_id", wsId);
  console.log("annotations:", ann);
})();
