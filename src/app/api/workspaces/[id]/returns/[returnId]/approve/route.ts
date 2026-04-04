import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getShopifyCredentials } from "@/lib/shopify-sync";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";

const RETURN_APPROVE_REQUEST_MUTATION = `
  mutation ReturnApproveRequest($input: ReturnApproveRequestInput!) {
    returnApproveRequest(input: $input) {
      return { id status }
      userErrors { field message }
    }
  }
`;

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; returnId: string }> },
) {
  const { id: workspaceId, returnId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  // Get the return record
  const { data: ret, error: fetchError } = await admin
    .from("returns")
    .select("id, shopify_return_gid, status")
    .eq("id", returnId)
    .eq("workspace_id", workspaceId)
    .single();

  if (fetchError || !ret) {
    return NextResponse.json({ error: "Return not found" }, { status: 404 });
  }

  if (ret.status !== "pending") {
    return NextResponse.json({ error: "Return is not in pending status" }, { status: 400 });
  }

  if (!ret.shopify_return_gid) {
    return NextResponse.json({ error: "Return has no Shopify GID" }, { status: 400 });
  }

  try {
    const { shop, accessToken } = await getShopifyCredentials(workspaceId);

    const res = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: RETURN_APPROVE_REQUEST_MUTATION,
          variables: { input: { id: ret.shopify_return_gid } },
        }),
      },
    );

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json({ error: `Shopify API error: ${res.status} ${text}` }, { status: 502 });
    }

    const result = await res.json();

    if (result.errors?.length) {
      return NextResponse.json({ error: result.errors[0].message }, { status: 502 });
    }

    const data = result.data?.returnApproveRequest as {
      return: { id: string; status: string } | null;
      userErrors: { field: string; message: string }[];
    };

    if (data.userErrors?.length) {
      return NextResponse.json({ error: data.userErrors[0].message }, { status: 400 });
    }

    // Update our DB
    await admin
      .from("returns")
      .update({ status: "open", updated_at: new Date().toISOString() })
      .eq("id", returnId)
      .eq("workspace_id", workspaceId);

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error(`Failed to approve return ${returnId}:`, err);
    return NextResponse.json({ error: "Failed to approve return" }, { status: 500 });
  }
}
