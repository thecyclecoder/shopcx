#!/usr/bin/env bash
# One command to finish the Remotion Lambda setup AFTER the AWS CLI is
# authenticated as an admin (`aws configure set ...`). Does everything that's
# left in the spec's Phase 6 that doesn't require a human:
#   1. verify AWS identity
#   2. create remotion-user + remotion-lambda-role (+ access key)
#   3. write REMOTION_AWS_* + REMOTION_RENDER_MODE to .env.local
#   4. deploy the Lambda function + S3 bucket + composition site
#   5. print the env block to paste into Vercel
#
#   bash scripts/aws/finish-lambda-setup.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
ENV_FILE="$ROOT/.env.local"
REGION="${AWS_REGION:-us-east-1}"
USER_NAME="remotion-user"
ROLE_NAME="remotion-lambda-role"

echo "== 1. AWS identity =="
aws sts get-caller-identity --output text || { echo "Not authenticated. Run: aws configure set aws_access_key_id <ID>; aws configure set aws_secret_access_key <SECRET>; aws configure set region $REGION"; exit 1; }

echo "== 2. IAM user + role =="
aws iam get-user --user-name "$USER_NAME" >/dev/null 2>&1 || aws iam create-user --user-name "$USER_NAME" >/dev/null
aws iam put-user-policy --user-name "$USER_NAME" --policy-name remotion-user-policy --policy-document "file://$HERE/remotion-user-policy.json"
aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1 || aws iam create-role --role-name "$ROLE_NAME" --assume-role-policy-document "file://$HERE/remotion-trust-policy.json" >/dev/null
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name remotion-role-policy --policy-document "file://$HERE/remotion-role-policy.json"

KEY_JSON=$(aws iam create-access-key --user-name "$USER_NAME" --output json)
AKID=$(echo "$KEY_JSON" | grep -o '"AccessKeyId": *"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/')
SECRET=$(echo "$KEY_JSON" | grep -o '"SecretAccessKey": *"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/')
echo "  created access key $AKID for $USER_NAME"

echo "== 3. write .env.local =="
upsert() { local k="$1" v="$2"; if grep -q "^$k=" "$ENV_FILE" 2>/dev/null; then sed -i '' "s|^$k=.*|$k=$v|" "$ENV_FILE"; else printf '\n%s=%s' "$k" "$v" >> "$ENV_FILE"; fi; }
upsert REMOTION_AWS_ACCESS_KEY_ID "$AKID"
upsert REMOTION_AWS_SECRET_ACCESS_KEY "$SECRET"
upsert REMOTION_AWS_REGION "$REGION"
upsert REMOTION_RENDER_MODE lambda
echo "  wrote REMOTION_AWS_* + REMOTION_RENDER_MODE"

echo "== 4. deploy function + site + bucket (may take a few min) =="
( cd "$ROOT" && REMOTION_AWS_ACCESS_KEY_ID="$AKID" REMOTION_AWS_SECRET_ACCESS_KEY="$SECRET" REMOTION_AWS_REGION="$REGION" npx tsx scripts/deploy-remotion-lambda.ts )

echo
echo "== 5. Now paste into Vercel env (Production) =="
echo "   REMOTION_RENDER_MODE, REMOTION_AWS_REGION, REMOTION_AWS_ACCESS_KEY_ID,"
echo "   REMOTION_AWS_SECRET_ACCESS_KEY, REMOTION_LAMBDA_FUNCTION_NAME,"
echo "   REMOTION_LAMBDA_SERVE_URL, REMOTION_S3_BUCKET  (+ ensure OPENAI_API_KEY)"
echo "   (function name / serve url / bucket are printed just above)"
echo "Then render an ad from /dashboard/marketing/ads/[id] — it'll render on Lambda."
