#!/usr/bin/env bash
# SubagentStop hook (hardening ticket 07). Never kills anything: if the stopping
# subagent's worktree is named by a still-running shell/monitor task, it exits 2
# so the subagent gets one more turn to TaskStop its own tasks. stop_hook_active
# true -> exit 0 (never loops). One log line per event; ARGUS_HOOK_LOG overrides
# the path (tests).
log=${ARGUS_HOOK_LOG:-$HOME/.local/state/argus/subagent-stop.log}
in=$(cat)

active=$(jq -r '.stop_hook_active // false' <<<"$in" 2>/dev/null) || exit 0
cwd=$(jq -r '.cwd // ""' <<<"$in")
agent=$(jq -r '.agent_type // ""' <<<"$in")
total=$(jq -r '(.background_tasks // []) | length' <<<"$in")

# Only subagents in their own worktree can be attributed; the path is the tie.
hits=""
case "$cwd" in
  */.claude/worktrees/?*)
    hits=$(jq -r --arg wt "$cwd" '
      (.background_tasks // [])[]
      | select(.status == "running" and (.type == "shell" or .type == "monitor"))
      | select((.command // "") | contains($wt))
      | "  \(.id): \(.command // .description)"' <<<"$in")
    ;;
esac

n=0
[ -n "$hits" ] && n=$(printf '%s\n' "$hits" | wc -l)
mkdir -p "$(dirname "$log")" 2>/dev/null
printf '%s agent=%s cwd=%s active=%s tasks=%s matched=%s\n' \
  "$(date -Is)" "$agent" "$cwd" "$active" "$total" "$n" >>"$log" 2>/dev/null

[ "$active" = true ] && exit 0
[ "$n" -gt 0 ] || exit 0

{
  echo "You are finishing with background task(s) of this worktree still running:"
  printf '%s\n' "$hits"
  echo "Stop each with TaskStop (or wait for it to finish) before you report."
} >&2
exit 2
