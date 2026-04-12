-- Crisis context: "skip it" or "just skip" is a save, not a cancel

INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT w.id, 'rule', 'Crisis skip intent', 'On a crisis/out-of-stock ticket, when a customer says "skip it", "just skip", "skip my order", or "skip or cancel" — this is a SAVE opportunity, not a cancel. Use get_crisis_status to check their crisis context. Offer: 1) Remove the out-of-stock item and keep shipping the rest (crisis_remove — auto-readd when back in stock), or 2) Pause the subscription until the product is back (crisis_pause — auto-resume on restock). Only route to the cancel journey if the customer explicitly and solely says "cancel" with no skip alternative mentioned.', 27
FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM sonnet_prompts sp WHERE sp.workspace_id = w.id AND sp.title = 'Crisis skip intent');
