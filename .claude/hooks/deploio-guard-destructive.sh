#!/bin/bash
# Deploio Destructive Command Guard
# Blocks dangerous nctl operations and requires the user to confirm manually.
# Used as a PreToolUse hook on Bash — receives JSON via stdin.
# Exit 0 = allow, Exit 2 = block (message sent to Claude via stderr).

# PreToolUse hooks receive the tool-call payload as JSON on stdin — cat gets it.
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

if [ -z "$COMMAND" ]; then
  exit 0
fi

# --- Irreversible deletions (data loss) -------------------------------------
# Match any `nctl delete <resource>` — we intentionally don't enumerate
# resource types so future additions (new services, etc.) are covered.
if echo "$COMMAND" | grep -qE '\bnctl\s+delete\b'; then
  RESOURCE=$(echo "$COMMAND" | grep -oE '\bnctl\s+delete\s+\S+' | awk '{print $3}')
  echo "BLOCKED: 'nctl delete ${RESOURCE}' permanently destroys the resource and all its data. Run this command manually in your terminal if you're sure." >&2
  exit 2
fi

# --- Scale to zero (stops serving traffic) ----------------------------------
# Anchor on the flag itself rather than the subcommand — `nctl update app`
# and `nctl update application` are both valid, and we want to catch both.
if echo "$COMMAND" | grep -qE '(^|\s)--replicas[= ]0\b'; then
  echo "BLOCKED: Setting replicas to 0 stops the app entirely. Run this command manually in your terminal if you're sure." >&2
  exit 2
fi

# --- Destructive database operations via exec -------------------------------
if echo "$COMMAND" | grep -qE '\bnctl\s+exec\b' && echo "$COMMAND" | grep -qE '(db:drop|db:reset|db:seed:replant|DISABLE_DATABASE_ENVIRONMENT_CHECK)'; then
  echo "BLOCKED: Destructive database operation detected inside nctl exec. Run this command manually in your terminal if you're sure." >&2
  exit 2
fi

exit 0
