-- RPC to increment macro usage count
CREATE OR REPLACE FUNCTION public.increment_macro_usage(macro_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.macros
  SET usage_count = usage_count + 1, updated_at = now()
  WHERE id = macro_id;
END;
$$;
