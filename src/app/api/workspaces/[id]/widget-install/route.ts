import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getShopifyCredentials } from "@/lib/shopify-sync";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";

// POST: Auto-install chat widget into Shopify theme
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const { shop, accessToken } = await getShopifyCredentials(workspaceId);

    // 1. Get the active theme
    const themesRes = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/themes.json`,
      { headers: { "X-Shopify-Access-Token": accessToken } }
    );
    const themesData = await themesRes.json();
    const activeTheme = themesData.themes?.find((t: { role: string }) => t.role === "main");

    if (!activeTheme) {
      return NextResponse.json({ error: "No active theme found" }, { status: 404 });
    }

    // 2. Read the current theme.liquid
    const assetRes = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/themes/${activeTheme.id}/assets.json?asset[key]=layout/theme.liquid`,
      { headers: { "X-Shopify-Access-Token": accessToken } }
    );
    const assetData = await assetRes.json();
    const themeContent = assetData.asset?.value;

    if (!themeContent) {
      return NextResponse.json({ error: "Could not read theme.liquid" }, { status: 500 });
    }

    // 3. Check if widget is already installed
    if (themeContent.includes("shopcx.ai/widget.js")) {
      return NextResponse.json({ already_installed: true, theme: activeTheme.name });
    }

    // 4. Build the widget snippet with Shopify Liquid customer data
    const snippet = [
      "",
      "<!-- ShopCX.ai Live Chat Widget -->",
      "<script",
      `  src="https://shopcx.ai/widget.js"`,
      `  data-workspace="${workspaceId}"`,
      "  {% if customer %}",
      '  data-customer-id="{{ customer.id }}"',
      '  data-customer-email="{{ customer.email }}"',
      '  data-customer-name="{{ customer.name }}"',
      "  {% endif %}",
      "  async",
      "></script>",
      "<!-- End ShopCX.ai Widget -->",
      "",
    ].join("\n");

    // 5. Inject before </body>
    const updatedContent = themeContent.replace(
      "</body>",
      snippet + "\n</body>"
    );

    // 6. Write back to Shopify
    const updateRes = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/themes/${activeTheme.id}/assets.json`,
      {
        method: "PUT",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          asset: {
            key: "layout/theme.liquid",
            value: updatedContent,
          },
        }),
      }
    );

    if (!updateRes.ok) {
      const err = await updateRes.json();
      return NextResponse.json({ error: err.errors || "Failed to update theme" }, { status: 500 });
    }

    return NextResponse.json({ success: true, theme: activeTheme.name });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

// DELETE: Remove chat widget from Shopify theme
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { shop, accessToken } = await getShopifyCredentials(workspaceId);

    const themesRes = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/themes.json`,
      { headers: { "X-Shopify-Access-Token": accessToken } }
    );
    const themesData = await themesRes.json();
    const activeTheme = themesData.themes?.find((t: { role: string }) => t.role === "main");

    if (!activeTheme) {
      return NextResponse.json({ error: "No active theme found" }, { status: 404 });
    }

    const assetRes = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/themes/${activeTheme.id}/assets.json?asset[key]=layout/theme.liquid`,
      { headers: { "X-Shopify-Access-Token": accessToken } }
    );
    const assetData = await assetRes.json();
    const themeContent = assetData.asset?.value;

    if (!themeContent || !themeContent.includes("shopcx.ai/widget.js")) {
      return NextResponse.json({ not_installed: true });
    }

    // Remove the widget snippet
    const updatedContent = themeContent.replace(
      /\n*<!-- ShopCX\.ai Live Chat Widget -->[\s\S]*?<!-- End ShopCX\.ai Widget -->\n*/,
      "\n"
    );

    await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/themes/${activeTheme.id}/assets.json`,
      {
        method: "PUT",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          asset: { key: "layout/theme.liquid", value: updatedContent },
        }),
      }
    );

    return NextResponse.json({ success: true, removed: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
