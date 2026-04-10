-- Add inventory sync timestamp to products table
-- Inventory quantities are stored per-variant inside the variants JSONB array
ALTER TABLE products ADD COLUMN IF NOT EXISTS inventory_updated_at timestamptz;
