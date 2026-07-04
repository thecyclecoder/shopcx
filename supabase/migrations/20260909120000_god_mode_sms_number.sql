-- god_mode_sms_number: the founder's mobile number for god-mode SMS delivery.
--
-- Phase 5 of docs/brain/specs/god-mode.md. When god-mode SMS fires (on arm,
-- new pending approval, session done), it looks this column up FIRST; if
-- unset, it falls back to process.env.GOD_MODE_FOUNDER_PHONE (a system-wide
-- default the box operator can set). The founder mobile is deliberately NOT
-- hardcoded in source (spec: "SECURE CONFIG value (env / workspace config),
-- not hardcoded in source").
--
-- Plain text (not `_encrypted`) — a phone number is not a cryptographic
-- secret and every other workspace phone in this schema (twilio_phone_number,
-- customer.phone) is plain text. Nullable — an unset column falls back to
-- env; both unset means SMS is a silent no-op (god-mode still works via the
-- dashboard tab, just no push notification).

alter table public.workspaces
  add column if not exists god_mode_sms_number text;
