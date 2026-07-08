-- Phase 5 of docs/brain/specs/rpc-ify-aggregation-layer-fix-1000-row-truncation.md.
--
-- Two RPCs that collapse the detail-view round-trip fan-out + converge on a
-- single SQL primitive for the "expand a customer to its link-group" pattern
-- that was being open-coded across every ticket / timeline / stats caller:
--
--   1. public.resolve_customer_link_group(p_customer_id uuid) → uuid[]
--        Returns the full set of customer_ids in the same customer_links group
--        (or [p_customer_id] when the customer is unlinked). Replaces the JS
--        two-hop scan pattern in src/lib/customer-timeline.ts
--        `resolveLinkedCustomerIds` + the same shape in the tickets detail
--        route. Callers keep the array-typed contract exactly.
--
--   2. public.ticket_users(p_workspace uuid, p_user_ids uuid[])
--        → TABLE(user_id, display_name, email)
--        Batched author lookup for the tickets detail route. Prior route
--        issued a per-uid admin.auth.admin.getUserById() call in parallel to
--        get email (workspace_members has display_name but not email) —
--        auth API calls each cross the auth service boundary and gate the
--        response on the slowest one. This RPC joins workspace_members ⨝
--        auth.users in ONE round-trip. SECURITY DEFINER — the caller is the
--        admin (service_role) client only.

-- ── 1. resolve_customer_link_group ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.resolve_customer_link_group(
  p_customer_id uuid
) RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH own_link AS (
    SELECT group_id
    FROM public.customer_links
    WHERE customer_id = p_customer_id
    LIMIT 1
  ),
  group_members AS (
    SELECT cl.customer_id
    FROM public.customer_links cl
    JOIN own_link ol ON ol.group_id = cl.group_id
  )
  SELECT COALESCE(
    (SELECT array_agg(customer_id ORDER BY customer_id) FROM group_members),
    ARRAY[p_customer_id]::uuid[]
  );
$$;

COMMENT ON FUNCTION public.resolve_customer_link_group(uuid) IS
  'Returns the full customer_ids array for the given customer''s customer_links group (or [p_customer_id] when the customer is unlinked). Convergence point for the two-hop JS expansion previously open-coded in src/lib/customer-timeline.ts resolveLinkedCustomerIds and the tickets detail route.';

GRANT EXECUTE ON FUNCTION public.resolve_customer_link_group(uuid)
  TO service_role, authenticated;


-- ── 2. ticket_users — batched user lookup joining auth.users ────────────────
CREATE OR REPLACE FUNCTION public.ticket_users(
  p_workspace uuid,
  p_user_ids uuid[]
) RETURNS TABLE(
  user_id uuid,
  display_name text,
  email text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT wm.user_id,
         wm.display_name,
         u.email::text AS email
  FROM public.workspace_members wm
  LEFT JOIN auth.users u ON u.id = wm.user_id
  WHERE wm.workspace_id = p_workspace
    AND wm.user_id = ANY(coalesce(p_user_ids, ARRAY[]::uuid[]));
$$;

COMMENT ON FUNCTION public.ticket_users(uuid, uuid[]) IS
  'Batched (user_id → display_name, email) for the tickets detail author-name enrichment. Replaces the per-uid admin.auth.admin.getUserById() loop in src/app/api/tickets/:id/route.ts with a single workspace_members ⨝ auth.users round-trip.';

GRANT EXECUTE ON FUNCTION public.ticket_users(uuid, uuid[])
  TO service_role, authenticated;
