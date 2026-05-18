-- Permanent per-customer shortcode for SMS shortlinks.
--
-- URL shape: superfd.co/{slug}/{customers.short_code}
--   - {slug} = leased shortlink slug per campaign (existing marketing_shortlinks)
--   - {short_code} = permanent per-customer code (this column)
--
-- 5 chars Crockford base32 = ~33M namespace, ~0.4% saturation at our 138K
-- subscriber count. Plenty of headroom; collisions on insert are handled
-- by retrying with a fresh value.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS short_code VARCHAR(5);

CREATE UNIQUE INDEX IF NOT EXISTS customers_short_code_unique
  ON customers (workspace_id, short_code)
  WHERE short_code IS NOT NULL;

-- Helper to generate a Crockford base32 code of N chars.
-- Crockford alphabet = 0123456789ABCDEFGHJKMNPQRSTVWXYZ (no I L O U — fewer mistakes).
-- Idempotent on duplicate calls; uniqueness enforced by the partial index above.
CREATE OR REPLACE FUNCTION generate_crockford_code(n INTEGER)
RETURNS TEXT AS $$
DECLARE
  alphabet TEXT := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  result   TEXT := '';
  i        INTEGER;
BEGIN
  FOR i IN 1..n LOOP
    result := result || substr(alphabet, 1 + (floor(random() * 32))::int, 1);
  END LOOP;
  RETURN result;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- Trigger to auto-assign short_code on insert if not provided. Retries on
-- collision (loop bounded — at 0.4% saturation, average retries ≈ 1.004).
CREATE OR REPLACE FUNCTION assign_customer_short_code()
RETURNS TRIGGER AS $$
DECLARE
  candidate TEXT;
  attempts  INTEGER := 0;
BEGIN
  IF NEW.short_code IS NOT NULL THEN
    RETURN NEW;
  END IF;
  LOOP
    candidate := generate_crockford_code(5);
    attempts := attempts + 1;
    IF NOT EXISTS (
      SELECT 1 FROM customers
      WHERE workspace_id = NEW.workspace_id AND short_code = candidate
    ) THEN
      NEW.short_code := candidate;
      RETURN NEW;
    END IF;
    IF attempts > 50 THEN
      -- Should never happen at our scale; fail loud rather than ship a NULL.
      RAISE EXCEPTION 'Could not generate unique customer short_code after 50 attempts';
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS customers_assign_short_code ON customers;
CREATE TRIGGER customers_assign_short_code
  BEFORE INSERT ON customers
  FOR EACH ROW
  EXECUTE FUNCTION assign_customer_short_code();
