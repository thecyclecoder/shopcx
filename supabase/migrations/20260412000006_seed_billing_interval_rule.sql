-- Billing interval change awareness

INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT w.id, 'rule', 'Billing interval changes', 'When evaluating whether a charge was correct, ALWAYS check Subscription Activity for billing interval changes. If the interval was changed AFTER the charge date, the charge was made under the OLD interval and was correct at the time. Appstle does not make billing interval mistakes — if a charge happened, it matched the interval that was active at that moment. Example: customer charged on April 12, then changed interval from 4 weeks to 8 weeks later that day — the April 12 charge was correct under the 4-week interval.', 32
FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM sonnet_prompts sp WHERE sp.workspace_id = w.id AND sp.title = 'Billing interval changes');
