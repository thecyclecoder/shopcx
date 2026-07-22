import { notFound } from "next/navigation";
import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/supabase/server";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { getProductIntelligence } from "@/lib/product-intelligence";
import { listAnglePalette } from "@/lib/ads/angle-palette";
import { ProductCreativePanel } from "@/components/product-creative-panel";

// Server Component — reads workspace + product basics + v3 angle palette server-side, then hands
// off to the shared client panel component. Active tests + latest previews are fetched client-side
// from /api/products/[id]/creative-panel; top-combinations-by-ROAS is blocked on the factor-rollup
// SDK's Phase 2 (see the panel component's TopCombinationsBlock comment).
//
// Auth: owner/admin only — same rail the shipped /api/ads/angles route uses.
export default async function ProductCreativePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: productId } = await params;

  const { user } = await getAuthedUser();
  if (!user) return notFound();

  const workspaceId = await getActiveWorkspaceId();
  if (!workspaceId) return notFound();

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || !["owner", "admin"].includes(member.role as string)) return notFound();

  const [intelligence, palette] = await Promise.all([
    getProductIntelligence(admin, workspaceId, productId),
    listAnglePalette(admin, workspaceId, productId),
  ]);

  if (!intelligence.product) return notFound();
  const productTitle = ((intelligence.product as { title?: string }).title as string | null) ?? null;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pt-4">
      <ProductTabs productId={productId} active="creative" />
      <ProductCreativePanel
        productId={productId}
        productTitle={productTitle}
        palette={palette}
      />
    </div>
  );
}

// A minimal peer-tab strip so /intelligence and /creative are discoverable from each other. Kept
// inline (not a shared component) because the intelligence page is a client component with its own
// header layout; a full layout-level tab strip would require refactoring intelligence — Phase 1's
// deliverable is the creative surface, not an intelligence rewrite.
function ProductTabs({ productId, active }: { productId: string; active: "intelligence" | "creative" }) {
  const base = "px-3 py-1.5 text-sm rounded-md transition";
  const on = "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900";
  const off = "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800";
  return (
    <nav className="flex items-center gap-1 border-b border-zinc-200 pb-3 dark:border-zinc-800">
      <Link
        href={`/dashboard/products/${productId}/intelligence`}
        className={`${base} ${active === "intelligence" ? on : off}`}
      >
        Intelligence
      </Link>
      <Link
        href={`/dashboard/products/${productId}/creative`}
        className={`${base} ${active === "creative" ? on : off}`}
      >
        Creative
      </Link>
    </nav>
  );
}
