-- Positive confirmation should not run on new tickets, only on replies
-- Lower priority and change match_target so it doesn't interfere
-- The actual positive confirmation logic is in the email webhook's isShortPositiveReply()
-- This pattern entry is not needed for auto-tagging — delete it
DELETE FROM public.smart_patterns WHERE category = 'positive_confirmation' AND workspace_id IS NULL;
