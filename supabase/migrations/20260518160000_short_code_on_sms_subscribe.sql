-- Also auto-assign customers.short_code when an existing customer
-- transitions to sms_marketing_status='subscribed' (or any other path
-- that updates them while short_code is still NULL — covers Shopify
-- webhook updates, direct-action subscribe paths, journey completions).
--
-- Together with the existing BEFORE INSERT trigger from
-- 20260518150000_customers_short_code.sql, this guarantees every SMS-
-- subscribed customer ends up with a code, regardless of which upstream
-- path created or modified them.

CREATE OR REPLACE FUNCTION assign_customer_short_code_on_update()
RETURNS TRIGGER AS $$
DECLARE
  candidate TEXT;
  attempts  INTEGER := 0;
BEGIN
  -- Only act when we need a code and the row is becoming (or already is)
  -- an SMS subscriber. Non-subscribers stay null-coded; they'll get one
  -- if they ever subscribe.
  IF NEW.short_code IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.sms_marketing_status IS DISTINCT FROM 'subscribed' THEN
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
      RAISE EXCEPTION 'Could not generate unique customer short_code after 50 attempts';
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS customers_assign_short_code_on_update ON customers;
CREATE TRIGGER customers_assign_short_code_on_update
  BEFORE UPDATE OF sms_marketing_status, short_code ON customers
  FOR EACH ROW
  WHEN (NEW.short_code IS NULL AND NEW.sms_marketing_status = 'subscribed')
  EXECUTE FUNCTION assign_customer_short_code_on_update();
