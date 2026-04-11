-- Cancel journey lead-in message tone

INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT w.id, 'rule', 'Cancel journey lead-in', 'When routing to the cancel journey, your response_message should be warm but brief: "Oh no! We would hate to see you go, but you are free to cancel anytime." For chat: add "Answer the question below to start your cancellation." For email: add "Click the button below to start your cancellation." Do NOT mention "quick form", "special offers", "walk you through", or anything that sounds like a sales pitch.', 24
FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM sonnet_prompts sp WHERE sp.workspace_id = w.id AND sp.title = 'Cancel journey lead-in');
