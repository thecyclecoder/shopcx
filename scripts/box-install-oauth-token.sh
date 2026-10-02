#!/usr/bin/env bash
# Install a `claude setup-token` token for ONE box Max pool account.
# Run as the builder user on the box (sudo -iu builder), after minting the token:
#
#   CLAUDE_CONFIG_DIR=~/.claude-personal claude setup-token     # approve in the browser, copy the printed token
#   bash ~/shopcx/scripts/box-install-oauth-token.sh ~/.claude-personal
#
# Writes <config-dir>/.oauth-token (mode 0600) and verifies it with a tiny `claude -p`. The worker picks
# it up within ~30s (no restart) and passes it to that account's sessions as CLAUDE_CODE_OAUTH_TOKEN.
# See docs/brain/recipes/build-box-setup.md § Long-lived setup-token auth.
set -euo pipefail

dir="${1:?usage: $0 <config dir, e.g. ~/.claude-personal>}"
dir="${dir%/}"
[ -d "$dir" ] || { echo "No such config dir: $dir" >&2; exit 1; }

printf 'Paste the token printed by `claude setup-token` (input hidden), then press Enter: '
IFS= read -rs tok
echo
tok="$(printf '%s' "$tok" | tr -d '[:space:]')"
if [ "${#tok}" -lt 20 ]; then
  echo "That doesn't look like a token (too short). Nothing was written." >&2
  exit 1
fi

echo "Verifying the token before saving it..."
if ! out="$(env -u ANTHROPIC_API_KEY CLAUDE_CONFIG_DIR="$dir" CLAUDE_CODE_OAUTH_TOKEN="$tok" timeout 120 claude -p "Reply with exactly: ok" 2>&1)"; then
  echo "Verification FAILED — the token was NOT saved. Output:" >&2
  echo "$out" >&2
  exit 1
fi
echo "claude replied: $out"

umask 077
tmp="$dir/.oauth-token.tmp.$$"
printf '%s\n' "$tok" > "$tmp"
chmod 600 "$tmp"
mv -f "$tmp" "$dir/.oauth-token"
echo "Saved $dir/.oauth-token. The box worker will use it for this account within ~30s."
