-- box-product-seeding: headless Google Drive access for the build box.
-- Stores the AES-256-GCM-encrypted Google Cloud service-account JSON key per workspace.
alter table public.workspaces
  add column if not exists google_drive_sa_json_encrypted text;

comment on column public.workspaces.google_drive_sa_json_encrypted is
  'AES-256-GCM encrypted Google Cloud service-account JSON key for headless Drive API access (box-product-seeding hero/asset sourcing). Decrypt via src/lib/crypto.ts.';
