#!/usr/bin/env bash
# Re-runnable cases for subagent-stop-sweep.sh. Usage: .claude/hooks/subagent-stop-sweep.test.sh
dir=$(dirname "$0")
hook="$dir/subagent-stop-sweep.sh"
tmp=$(mktemp -d "${TMPDIR:-/var/tmp}/sweep-test.XXXXXX")
export ARGUS_HOOK_LOG="$tmp/log"
fail=0 pids=()
tag="sweeptest$$"
wt="/home/x/code/argus/.claude/worktrees/agent-$tag"
other="/home/x/code/argus/.claude/worktrees/agent-other$$"

cleanup() {
  local p
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done
  rm -r "$tmp"
}
trap cleanup EXIT

# Stand-in processes: the subagent's leftover, a differently tagged sleep, a listener standing in for :3100.
sleep 600 & mine=$!; pids+=("$mine")
sleep 601 & unrelated=$!; pids+=("$unrelated")
python3 -I -c 'import socket,time;s=socket.socket();s.bind(("127.0.0.1",0));s.listen();time.sleep(600)' & listener=$!; pids+=("$listener")

payload() { # active, status, type, command, agent_type, cwd
  jq -n --argjson a "$1" --arg s "$2" --arg t "$3" --arg c "$4" --arg at "$5" --arg cwd "$6" \
    '{hook_event_name:"SubagentStop",stop_hook_active:$a,agent_type:$at,cwd:$cwd,
      background_tasks:[{id:"b1",type:$t,status:$s,command:$c,description:"d"}]}'
}
expect() { # name want-exit stderr-pattern(or "") payload
  local out got
  out=$(printf '%s' "$4" | "$hook" 2>&1 >/dev/null); got=$?
  if [ "$got" = "$2" ] && { [ -z "$3" ] && [ -z "$out" ] || [[ "$out" == *"$3"* && -n "$3" ]]; }; then echo "ok   $1"
  else echo "FAIL $1 (exit=$got want=$2 out=$out)"; fail=$((fail + 1)); fi
}

cmd="cd $wt && sleep 600 # $tag"
expect "flags own running shell task" 2 "b1" "$(payload false running shell "$cmd" general-purpose "$wt")"
expect "flags own monitor task" 2 "b1" "$(payload false running monitor "$cmd" verifier "$wt")"
expect "stop_hook_active exits 0" 0 "" "$(payload true running shell "$cmd" general-purpose "$wt")"
expect "other worktree's task untouched" 0 "" "$(payload false running shell "cd $other && sleep 600" general-purpose "$wt")"
expect "finished task" 0 "" "$(payload false completed shell "$cmd" general-purpose "$wt")"
expect "non-shell type" 0 "" "$(payload false running subagent "$cmd" general-purpose "$wt")"
expect "empty agent_type, no worktree cwd" 0 "" "$(payload false running shell "$cmd" "" "/home/x/code/argus")"
expect "empty background_tasks" 0 "" '{"stop_hook_active":false,"agent_type":"verifier","cwd":"'"$wt"'","background_tasks":[]}'
expect "no background_tasks field" 0 "" '{"agent_type":"verifier","cwd":"'"$wt"'"}'
expect "garbage input" 0 "" 'not json'

for p in "$mine" "$unrelated" "$listener"; do
  if kill -0 "$p" 2>/dev/null; then echo "ok   pid $p still alive"; else echo "FAIL pid $p was killed"; fail=$((fail + 1)); fi
done
[ -s "$ARGUS_HOOK_LOG" ] && echo "ok   log written" || { echo "FAIL no log line"; fail=$((fail + 1)); }

[ "$fail" = 0 ] && echo "all passed" || echo "$fail failed"
exit $((fail > 0))
