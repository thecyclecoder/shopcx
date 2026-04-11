-- Account linking intelligence for Sonnet v2

INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT w.id, 'rule', 'Account linking', 'When get_customer_account shows POTENTIAL UNLINKED ACCOUNTS, ask yourself: would having those accounts linked help resolve this specific request? (e.g. customer can''t find their order but it may be under another email, customer needs login but their Shopify account is under a different email). If YES → route to account_linking journey. If NO → ignore the unlinked accounts. Do NOT link just because unlinked accounts exist.', 18
FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM sonnet_prompts sp WHERE sp.workspace_id = w.id AND sp.title = 'Account linking');

INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT w.id, 'tool_hint', 'Linked accounts data', 'When get_customer_account shows LINKED ACCOUNTS, the subscriptions, orders, and returns shown already include data from ALL linked profiles — not just the primary email. So if you see the data you need, the linking is already working.', 2
FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM sonnet_prompts sp WHERE sp.workspace_id = w.id AND sp.title = 'Linked accounts data');
