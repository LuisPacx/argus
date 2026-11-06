#!/usr/bin/env bash
# Re-runnable cases for bash-guard.sh. Usage: .claude/hooks/bash-guard.test.sh
# Each case: expected exit code, then the Bash command piped in as hook JSON.
dir=$(dirname "$0")
guard="$dir/bash-guard.sh"
fail=0 deny=0 allow=0

check() {
  local want=$1 cmd=$2 got
  jq -n --arg c "$cmd" '{hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:$c}}' | "$guard" 2>/dev/null
  got=$?
  if [ "$want" = 2 ]; then deny=$((deny + 1)); else allow=$((allow + 1)); fi
  if [ "$got" = "$want" ]; then echo "ok   exit=$got  $cmd"; else echo "FAIL exit=$got want=$want  $cmd"; fail=$((fail + 1)); fi
}

# deny
check 2 "sed -i 's/a/b/' f.txt"
check 2 "sed -i.bak 's/a/b/' f.txt"
check 2 "sed --in-place 's/a/b/' f.txt"
check 2 "sed -ni 's/a/b/p' f.txt"
check 2 "echo hi; sed -i 's/a/b/' f.txt"
check 2 "ls && sed -i 's/a/b/' f.txt"
check 2 "cat f | sed -i 's/a/b/' g"
check 2 $'echo hi\nsed -i s/a/b/ f.txt'
check 2 "cd /x && ls"
check 2 "cd /x; ls"
check 2 "echo hi && cd /x && pnpm test"
check 2 $'echo hi\ncd src; ls'

# allow
check 0 "sed 's/a/b/' f.txt"
check 0 "sed -n '1,5p' f.txt"
check 0 "sed -e 's/a/b/' f.txt"
check 0 "echo abcd /x; ls"
check 0 "echo used files"
check 0 "cd /x"
check 0 "git -C /x status"
check 0 "pnpm --dir /x check"
check 0 "ls -la"

# quoted text and heredoc bodies are ignored; real uses outside them still deny
check 0 "git commit -m 'guard denies sed -i and cd x && y'"
check 0 'git commit -m "guard denies sed -i and cd x && y"'
check 0 $'gh issue comment 1 --body-file - <<\'EOF\'\nuse sed -i here\ncd /x && ls\nEOF'
check 0 $'cat <<-EOF\n\tsed -i s/a/b/ f\nEOF'
check 2 $'cat <<EOF\nnote\nEOF\nsed -i s/a/b/ f'
check 2 "sed -i 's/a/b/' f"
check 2 'sed -i "s/a/b/" f'
check 2 "cd '/my dir' && ls"
check 2 "git commit -m 'msg' && cd /x && ls"

echo "deny cases: $deny, allow cases: $allow, failures: $fail"
[ "$fail" = 0 ]
