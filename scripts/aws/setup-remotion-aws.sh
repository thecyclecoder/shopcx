#!/usr/bin/env bash
# Create the Remotion Lambda IAM user + role from the generated policy files.
# Run AFTER authenticating the AWS CLI as an admin (`aws configure`).
# Idempotent-ish: skips entities that already exist; always prints a fresh
# access key for remotion-user at the end (set those as REMOTION_AWS_* env vars).
#
#   bash scripts/aws/setup-remotion-aws.sh
#
# See docs/brain/integrations/remotion-lambda.md.
set -euo pipefail
cd "$(dirname "$0")"

USER_NAME="remotion-user"
ROLE_NAME="remotion-lambda-role"

echo "AWS identity:"; aws sts get-caller-identity --output text || { echo "Not authenticated — run: aws configure"; exit 1; }

# ── User ─────────────────────────────────────────────────────────────────────
aws iam get-user --user-name "$USER_NAME" >/dev/null 2>&1 || {
  echo "creating user $USER_NAME"; aws iam create-user --user-name "$USER_NAME" >/dev/null;
}
echo "attaching user policy"
aws iam put-user-policy --user-name "$USER_NAME" --policy-name remotion-user-policy --policy-document file://remotion-user-policy.json

# ── Role (assumed by Lambda) ─────────────────────────────────────────────────
aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1 || {
  echo "creating role $ROLE_NAME"; aws iam create-role --role-name "$ROLE_NAME" --assume-role-policy-document file://remotion-trust-policy.json >/dev/null;
}
echo "attaching role policy"
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name remotion-role-policy --policy-document file://remotion-role-policy.json

# ── Access key for the user ──────────────────────────────────────────────────
echo; echo "creating access key for $USER_NAME …"
KEY_JSON=$(aws iam create-access-key --user-name "$USER_NAME" --output json)
AKID=$(echo "$KEY_JSON" | grep -o '"AccessKeyId": *"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/')
SECRET=$(echo "$KEY_JSON" | grep -o '"SecretAccessKey": *"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/')

echo
echo "─── add these to .env.local AND Vercel env ───"
echo "REMOTION_AWS_ACCESS_KEY_ID=$AKID"
echo "REMOTION_AWS_SECRET_ACCESS_KEY=$SECRET"
echo "REMOTION_AWS_REGION=${AWS_REGION:-us-east-1}"
echo "REMOTION_RENDER_MODE=lambda"
echo "──────────────────────────────────────────────"
echo "(IAM access keys are shown only once — save them now. Then run: npx tsx scripts/deploy-remotion-lambda.ts)"
