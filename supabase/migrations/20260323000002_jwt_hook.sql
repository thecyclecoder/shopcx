-- Custom access token hook: injects workspace_id and workspace_role into JWT
CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  claims jsonb;
  ws_id uuid;
  ws_role text;
BEGIN
  claims := event->'claims';

  -- Get workspace_id from app_metadata
  ws_id := (claims->'app_metadata'->>'workspace_id')::uuid;

  IF ws_id IS NOT NULL THEN
    -- Look up the user's role in that workspace
    SELECT role::text INTO ws_role
    FROM public.workspace_members
    WHERE workspace_id = ws_id
      AND user_id = (claims->>'sub')::uuid;

    -- Set custom claims
    claims := jsonb_set(claims, '{workspace_id}', to_jsonb(ws_id::text));
    IF ws_role IS NOT NULL THEN
      claims := jsonb_set(claims, '{workspace_role}', to_jsonb(ws_role));
    END IF;
  END IF;

  event := jsonb_set(event, '{claims}', claims);
  RETURN event;
END;
$$;

-- Grant execute to supabase_auth_admin (required for the hook)
GRANT EXECUTE ON FUNCTION public.custom_access_token_hook TO supabase_auth_admin;
GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook FROM authenticated, anon, public;
