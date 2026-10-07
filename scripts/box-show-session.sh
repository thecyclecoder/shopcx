#!/usr/bin/env bash
# Show a box Claude session's transcript, readably, from its session id.
# Run on the box as the builder user (sudo -iu builder):
#
#   bash ~/shopcx/scripts/box-show-session.sh <session-id> [N]
#
# Transcripts live in <config dir>/projects/<cwd-slug>/<session-id>.jsonl under whichever Max account ran
# the session, so this searches all four config dirs. Prints the file path, then the last N (default 40)
# events as one line each: role, text (trimmed) or tool call / tool result, so you can see what the agent
# said at the end of the session — e.g. whether it wrote its JSON answer and then ended on an empty turn.
# Session ids for a job: agent_jobs.claude_session_id, or "session_id" in its log_tail.
set -euo pipefail

sid="${1:?usage: $0 <session-id> [N]}"
n="${2:-40}"
file=""
for d in ~/.claude ~/.claude-personal ~/.claude-third ~/.claude-fourth; do
  f="$(find "$d/projects" -name "$sid.jsonl" 2>/dev/null | head -1 || true)"
  if [ -n "$f" ]; then file="$f"; break; fi
done
[ -n "$file" ] || { echo "No transcript found for $sid under ~/.claude*/projects" >&2; exit 1; }
echo "== $file"
echo "== account dir: ${file%%/projects/*}"
tail -n "$n" "$file" | node -e '
  const lines = require("fs").readFileSync(0, "utf8").split("\n").filter(Boolean);
  for (const l of lines) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    const role = o.type || "?";
    const c = o.message && o.message.content;
    const parts = [];
    if (typeof c === "string") parts.push(c);
    else if (Array.isArray(c)) for (const b of c) {
      if (b.type === "text") parts.push(JSON.stringify(b.text.slice(0, 300)) + (b.text.length > 300 ? ` …(+${b.text.length - 300} chars)` : ""));
      else if (b.type === "tool_use") parts.push(`[tool_use ${b.name}]`);
      else if (b.type === "tool_result") parts.push("[tool_result]");
      else if (b.type === "thinking") parts.push("[thinking]");
      else parts.push(`[${b.type}]`);
    }
    const usage = o.message && o.message.usage ? ` out=${o.message.usage.output_tokens}` : "";
    const stop = o.message && o.message.stop_reason ? ` stop=${o.message.stop_reason}` : "";
    console.log(`${(o.timestamp || "").slice(11, 19)} ${role}${stop}${usage}: ${parts.join(" ") || "(empty)"}`);
  }
'
