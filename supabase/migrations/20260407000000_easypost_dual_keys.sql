-- Dual API key support for EasyPost (test + live)
-- Rename existing key to "test" key, add live key column + mode toggle

-- The existing easypost_api_key_encrypted becomes the test key
ALTER TABLE workspaces
  RENAME COLUMN easypost_api_key_encrypted TO easypost_test_api_key_encrypted;

-- Add live key column
ALTER TABLE workspaces
  ADD COLUMN easypost_live_api_key_encrypted TEXT;

-- Mode toggle: true = test (default), false = live
ALTER TABLE workspaces
  ADD COLUMN easypost_test_mode BOOLEAN NOT NULL DEFAULT true;
