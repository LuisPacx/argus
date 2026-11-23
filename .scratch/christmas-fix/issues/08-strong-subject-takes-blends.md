# 08: A strong subject (already a Meta) still takes matching blend graduates

Status: ready-for-agent

Model: sonnet, effort medium

## Problem

Replay of live run 641 (ticket 06 notes, commit 44f5f11): 6 of 26 Christmas-named graduates of the last 24 h stayed unassigned (Mas, BOSSMAS, ChristmASS x2, CATEMAS, Christmas Inu). Cause: xmas was already a Meta, and the blend pass never pads a strong subject. The Christmas Meta looks smaller than the wave.

## Acceptance

- [ ] The blend pass can assign a matching graduate to a subject that is already strong / a Meta, without lowering any entry threshold (rule in an ADR or ADR 0020 addendum).
- [ ] Assignment does not raise a New Meta event or change the Meta key (re-entry guard of christmas-fix 07 holds).
- [ ] A test replays run 641 (fixture from the live DB, read-only) and assigns CATEMAS, BOSSMAS, ChristmASS, Christmas Inu to xmas; any that stay out are listed with the reason.
- [ ] No unrelated token joins xmas in that replay (test).
- [ ] `pnpm check` passes.

## Comments
