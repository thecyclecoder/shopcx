-- Distinct ticket tags for the workspace, computed in the DB.
--
-- The /api/workspaces/[id]/tags endpoint used to `select("tags")` over all
-- tickets and dedupe in JS — but Supabase caps that at 1000 rows, so in a
-- workspace with >1000 tickets (the Gorgias migration is ~1.9K) any tag that
-- only appears on tickets outside the first 1000 was invisible. That made it
-- impossible to build a ticket view for a freshly-introduced tag (e.g.
-- `payment-recovery`). This function unnests + distinct's across the WHOLE
-- table so every tag in use is returned.
CREATE OR REPLACE FUNCTION public.distinct_ticket_tags(p_workspace_id uuid)
RETURNS TABLE(tag text)
LANGUAGE sql
STABLE
AS $$
  SELECT DISTINCT unnest(tags) AS tag
  FROM public.tickets
  WHERE workspace_id = p_workspace_id
    AND tags IS NOT NULL
    AND array_length(tags, 1) > 0
  ORDER BY tag;
$$;
