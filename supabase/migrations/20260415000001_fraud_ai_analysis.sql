-- Add ai_analysis JSONB column to fraud_cases for caching AI analysis results
ALTER TABLE fraud_cases ADD COLUMN IF NOT EXISTS ai_analysis JSONB;

COMMENT ON COLUMN fraud_cases.ai_analysis IS 'Cached AI analysis result — only re-run on explicit Re-analyze button click';
