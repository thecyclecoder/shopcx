-- Sonnet rule: prefer text-based account linking + pause action clarification.

INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT w.id, 'rule', 'Account linking via text confirmation',
$$When account linking is needed and the customer has stated another email in plain text (e.g. "the other email is X@Y.com", "yes both are mine", "I also use Z@example.com"):

DO NOT keep sending the account_linking journey form. Instead, call the direct action `link_account_by_email` with `code: "<the-email>"` to immediately link the accounts based on their text confirmation.

The journey form is a fallback for when the customer hasn't named the email or when their answer is ambiguous. If they've named an email and clearly affirmed ownership, link it directly and proceed with their actual request (cancel, pause, etc.) — don't make them fill out a form.

If `link_account_by_email` returns "No customer profile found for X", then surface that to the customer ("I'm not finding an account under that email — could you double-check?") rather than silently retrying the form.$$,
  6
FROM workspaces w
WHERE NOT EXISTS (
  SELECT 1 FROM sonnet_prompts sp
  WHERE sp.workspace_id = w.id AND sp.title = 'Account linking via text confirmation'
);

INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT w.id, 'rule', 'Pause action: 30 or 60 days only',
$$Use direct action `pause_timed` with `pause_days: 30` or `pause_days: 60`. The bare `pause` type is supported as an alias but will default to 30 days if no duration is given — be explicit.

NEVER promise pauses longer than 60 days (e.g. "I can pause for 6 months"). If a customer asks for a longer pause, explain that 60 days is the maximum self-service option and offer that, plus the option to come back and re-pause if they need more time. Longer pauses require an agent to apply manually.$$,
  7
FROM workspaces w
WHERE NOT EXISTS (
  SELECT 1 FROM sonnet_prompts sp
  WHERE sp.workspace_id = w.id AND sp.title = 'Pause action: 30 or 60 days only'
);
