-- Broaden cancel journey match patterns to catch misspellings and common variations
UPDATE journey_definitions
SET match_patterns = ARRAY['cancel my subscription','cancel subscription','stop charging me','cancel my order','stop my subscription','cancel my account','cancel account','want to cancel','i want to cancel','cancle','cancell','canel','unsubscribe','stop subscription','end my subscription','end subscription','close my account','stop my order','stop sending','stop deliveries','cancel deliveries','dont want it anymore']
WHERE id = 'a75b1a8f-5fa9-448e-9fac-0656e9f25a95';
