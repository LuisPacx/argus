#!/usr/bin/env bash
# PreToolUse hook for the Bash tool. Reads hook JSON on stdin; exit 2 + stderr denies.
# Enforces two rules from docs/agents/worker-rules.md: no in-place sed, no `cd <dir> &&`/`;`.

cmd=$(jq -r '.tool_input.command // empty' 2>/dev/null)
[ -z "$cmd" ] && exit 0

# Drop heredoc bodies and the contents of '...' and "..." so quoted text (commit messages,
# gh bodies, sed scripts) never matches. Quote marks stay, so `sed -i 's/a/b/' f` -> `sed -i '' f`.
cmd=$(printf '%s\n' "$cmd" | awk '
  {
    if (delim != "") {
      line = $0
      if (strip) sub(/^\t+/, "", line)
      if (line == delim) delim = ""
      next
    }
    text = text $0 "\n"
    if (match($0, /<<-?[ \t]*["\x27]?[A-Za-z_][A-Za-z_0-9]*/) && substr($0, RSTART - 1, 1) != "<") {
      d = substr($0, RSTART, RLENGTH)
      strip = (d ~ /^<<-/)
      sub(/^<<-?[ \t]*["\x27]?/, "", d)
      delim = d
    }
  }
  END {
    n = length(text); out = ""; q = ""
    for (i = 1; i <= n; i++) {
      c = substr(text, i, 1)
      if (q == "") {
        out = out c
        if (c == "\\") { i++; out = out substr(text, i, 1) }
        else if (c == "\x27" || c == "\"") q = c
      } else if (q == "\"" && c == "\\") {
        i++
      } else if (c == q) {
        out = out c; q = ""
      }
    }
    printf "%s", out
  }')

# Start of a word: line start or a char that cannot be part of a path/identifier.
pre='(^|[^[:alnum:]_./-])'

# sed with -i, -i.bak, -ni, --in-place (flag later on the same sed invocation).
if printf '%s\n' "$cmd" | grep -Eq "${pre}sed[[:space:]]([^;&|]*[[:space:]])?(-[A-Za-z]*i[^[:space:]]*|--in-place[^[:space:]]*)([[:space:]]|\$)"; then
  echo "Blocked: in-place sed. Use the Edit tool to change files." >&2
  exit 2
fi

# cd <dir> followed by && or ;
if printf '%s\n' "$cmd" | grep -Eq "${pre}cd[[:space:]]+[^;&|]+(&&|;)"; then
  echo "Blocked: cd chained with && or ;. Name the dir in the command: git -C <dir>, pnpm --dir <dir>, or an absolute path." >&2
  exit 2
fi

exit 0
