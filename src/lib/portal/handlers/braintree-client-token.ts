import type { RouteHandler } from "@/lib/portal/types";
import { errText } from "@/lib/error-text";
import { jsonOk, jsonErr, findCustomer, checkPortalBan } from "@/lib/portal/helpers";

/**
 * braintreeClientToken — a Braintree client token for the portal's Hosted Fields
 * "add a card" flow. Bound to the customer's Braintree customer id (resolved or
 * created) so the vaulted card attaches to the right customer. Mirrors the
 * checkout client-token route, but auth comes from the portal session (no cart).
 */
export const braintreeClientToken: RouteHandler = async ({ auth, route }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);
  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;

  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  if (!customer?.email) return jsonErr({ error: "customer_not_found" }, 404);

  let braintreeCustomerId: string | null = null;
  try {
    const { resolveBraintreeCustomerId } = await import("@/lib/integrations/braintree-customer");
    braintreeCustomerId = await resolveBraintreeCustomerId({
      workspaceId: auth.workspaceId,
      customerId: customer.id,
      email: customer.email,
      firstName: (customer.first_name as string | null) || undefined,
      lastName: (customer.last_name as string | null) || undefined,
    });
  } catch (err) {
    console.warn("[portal/braintreeClientToken] resolveBraintreeCustomerId threw:", err);
  }

  try {
    const { getBraintreeGateway } = await import("@/lib/integrations/braintree");
    const gateway = await getBraintreeGateway(auth.workspaceId);
    const opts: { customerId?: string } = {};
    if (braintreeCustomerId) opts.customerId = braintreeCustomerId;
    const result = await gateway.clientToken.generate(opts);
    if (!result.success) return jsonErr({ error: "braintree_error", message: result.message }, 502);
    return jsonOk({ ok: true, route, client_token: result.clientToken });
  } catch (err) {
    // Full lossless diagnostic stays in the server log; the public 500 body carries the stable
    // error code only (Fix 1 of lossless-error-diagnostics-no-object-object — errText's
    // PostgREST code/details/hint output would leak DB internals to a portal caller).
    console.error(`[portal/braintreeClientToken] gateway threw: ${errText(err)}`);
    return jsonErr({ error: "braintree_error" }, 500);
  }
};
