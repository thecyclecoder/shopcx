-- Merge "where_is_order" and "tracking_status" into a single pattern
-- Delete tracking_status
DELETE FROM public.smart_patterns WHERE category = 'tracking_status' AND workspace_id IS NULL;

-- Update where_is_order to include tracking phrases and rename
UPDATE public.smart_patterns
SET
  name = 'Order tracking / Where is my order',
  phrases = '["where is my order", "where''s my order", "have not received", "haven''t received", "not received", "still have not received", "did not receive", "we did not receive", "taking so long", "has been delayed", "where is it", "when will i get", "tracking number", "tracking info", "track my", "shipment status", "delivery status", "shipping update", "in transit", "been stuck", "stuck in transit", "check this shipment", "when will it be delivered", "when will it arrive"]',
  auto_tag = 'order-tracking'
WHERE category = 'where_is_order' AND workspace_id IS NULL;
