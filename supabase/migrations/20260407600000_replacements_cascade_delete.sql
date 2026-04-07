-- Allow ticket deletion when replacements reference it
ALTER TABLE replacements DROP CONSTRAINT IF EXISTS replacements_ticket_id_fkey;
ALTER TABLE replacements ADD CONSTRAINT replacements_ticket_id_fkey
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE SET NULL;
