-- Bootstrap: expand existing patterns + add new categories from ticket analysis

-- Expand where_is_order
UPDATE public.smart_patterns SET
  phrases = phrases || '["wheres my package", "order status pls", "still waiting on my order", "haven''''t received anything yet", "tracking info not working", "order stuck somewhere", "shipment delayed?", "when will it arrive", "package taking forever", "no updates on delivery", "order processing too long", "shipping confirmation missing", "expected delivery passed", "order lost in transit", "no movement on tracking"]'::jsonb,
  embedding = NULL
WHERE category = 'where_is_order' AND workspace_id IS NULL;

-- Expand cancel_request
UPDATE public.smart_patterns SET
  phrases = phrases || '["stop my order", "dont want this anymore", "please cancel everything", "end my account", "no more orders please", "stop sending me stuff", "discontinue service", "turn off auto orders", "halt my subscription", "cease all deliveries", "terminate my plan", "opt out completely", "cancel asap", "stop billing me", "end this now"]'::jsonb,
  embedding = NULL
WHERE category = 'cancel_request' AND workspace_id IS NULL;

-- Expand return_request
UPDATE public.smart_patterns SET
  phrases = phrases || '["send this back", "dont like the product", "wrong item received", "damaged goods", "product defective", "not what i ordered", "expired products", "bad quality", "return policy help", "refund this order", "exchange for different", "product recall", "allergic reaction", "taste is awful", "money back guarantee"]'::jsonb,
  embedding = NULL
WHERE category = 'return_request' AND workspace_id IS NULL;

-- Expand subscription_mgmt
UPDATE public.smart_patterns SET
  phrases = phrases || '["change my delivery date", "skip next shipment", "pause my account", "modify subscription", "update payment method", "change products", "adjust frequency", "hold my orders", "subscription settings", "manage my plan", "change billing cycle", "update delivery schedule", "swap products", "delay next order", "subscription preferences"]'::jsonb,
  embedding = NULL
WHERE category = 'subscription_mgmt' AND workspace_id IS NULL;

-- Expand not_delivered
UPDATE public.smart_patterns SET
  phrases = phrases || '["package never came", "missing delivery", "supposed to arrive yesterday", "delivery failed", "package stolen", "left at wrong address", "courier couldn''''t find me", "delivery attempt failed", "package missing", "never got my order", "delivery driver issues", "package lost", "delivery to wrong house", "porch pirate took it", "package disappeared"]'::jsonb,
  embedding = NULL
WHERE category = 'not_delivered' AND workspace_id IS NULL;

INSERT INTO public.smart_patterns (workspace_id, category, name, description, phrases, match_target, priority, auto_tag, source) VALUES
(NULL, 'payment_billing', 'Payment and billing issues', 'Customer inquiries related to payment problems, billing disputes, credit card issues, refunds, and charges. Includes failed payments, incorrect charges, payment method updates, and billing cycle questions.', '["payment declined", "credit card not working", "wrong amount charged", "double charged", "refund my money", "billing error", "payment failed", "card expired", "unauthorized charge", "incorrect billing", "refund request", "payment issue", "charged twice", "billing dispute", "money back", "payment not processing", "bank declined", "overcharged", "billing question", "refund status"]', 'both', 40, 'billing-issue', 'seed');

INSERT INTO public.smart_patterns (workspace_id, category, name, description, phrases, match_target, priority, auto_tag, source) VALUES
(NULL, 'customer_support', 'General customer support and contact requests', 'Customer requests to speak with support representatives, callback requests, general inquiries, and requests for human assistance. Includes phone calls, chat requests, and general help seeking behavior.', '["need to talk to someone", "call me back", "speak to representative", "customer service help", "need assistance", "talk to human", "callback request", "need help", "contact support", "speak to agent", "customer service", "help me please", "need to call", "talk to someone", "live chat", "phone support", "escalate issue", "manager please", "human help", "support ticket"]', 'both', 40, 'support-request', 'seed');

INSERT INTO public.smart_patterns (workspace_id, category, name, description, phrases, match_target, priority, auto_tag, source) VALUES
(NULL, 'product_inquiry', 'Product information and ingredient questions', 'Customer questions about product ingredients, nutritional information, health benefits, usage instructions, and product recommendations. Includes dietary restrictions, allergen concerns, and supplement guidance.', '["ingredient list", "whats in this product", "nutrition facts", "allergen information", "gluten free options", "vegan products", "side effects", "how to use", "dosage instructions", "product benefits", "organic certification", "sugar content", "caffeine free", "keto friendly", "health benefits", "product comparison", "recommended dosage", "expiration date", "storage instructions", "product reviews"]', 'both', 40, 'product-info', 'seed');

INSERT INTO public.smart_patterns (workspace_id, category, name, description, phrases, match_target, priority, auto_tag, source) VALUES
(NULL, 'account_access', 'Account login and access issues', 'Customer problems with logging into their account, password resets, email verification, account recovery, and profile management. Includes forgotten credentials, locked accounts, and login technical difficulties.', '["forgot password", "cant log in", "account locked", "password reset", "login issues", "account recovery", "email verification", "username forgotten", "access denied", "login error", "account disabled", "password not working", "email not recognized", "account suspended", "login help", "reset my account", "cant access account", "verification code", "account blocked", "login problems"]', 'both', 40, 'account-access', 'seed');

