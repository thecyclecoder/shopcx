-- Second-touch abandoned-cart follow-up. abandoned_email_sent_at already marks
-- the first touch (~30 min after a cart goes idle); this column marks the
-- follow-up (~24 h after the first touch). Two touches max, lifetime, per cart.

alter table public.cart_drafts
  add column if not exists abandoned_followup_sent_at timestamptz;
