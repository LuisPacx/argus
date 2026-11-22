# 06: Live check that the live tick shows Christmas as one Meta
**Model:** haiku / low — read one live tick and compare it with a short checklist; no code.

**What to build:** After tickets 03 and 05 are merged and the worker runs the merged build, read one live Meta tick (the latest `meta_runs` / `meta_current` run and the War Room Meta page) and confirm the Christmas wave shows as a single Meta. Record the observed counts on this ticket as a note. This ticket closes the last open box of graduation-meta ticket 01 ("After merge, one live tick shows Christmas as a Meta"). If the check fails, write what the tick shows (subject keys, counts, unassigned graduates) on this ticket and leave it open; do not change code.

**Blocked by:** 03, 05

Status: in-progress
- [ ] One live tick lists a single Meta for the Christmas wave (not several split subjects), with its 24 h graduations, 6 h graduations and creators recorded as a note on this ticket.
- [ ] No Christmas-named blend graduate (such as Bullmas or CATEMAS) is left unassigned in that tick, or the leftovers are listed with the reason.
- [ ] A second tick shortly after keeps the same subject key and raises no New Meta event.
- [ ] The last box of `.scratch/graduation-meta/issues/01-graduation-count-meta-rule.md` is ticked once the check passes.

## Comments
- 2026-11-22 18:07 [d37fa1ed] From 04 review: test CATEMAS joins only via hand-fed memberKeys ['mas']; no word-level stem matches it. Live check must confirm CATEMAS really joins Christmas on real data.
- 2026-11-22 19:37 [d37fa1ed] Live worker (supervised, started 07:55) and warroom predate 910b272. Plan: Haiku runs pnpm dev:stop/dev:start, reads first tick from .data/argus.db read-only, notes counts here; second tick ~15 min later checks key + no New Meta.
- 2026-11-22 19:39 [d37fa1ed] Run 625 (computedAt 2026-11-22T19:37:39Z, first tick after restart): Christmas is watching key xmas, NOT a Meta; only Meta is gta6. xmas: 24h grads 8, 6h 6, creators 8, blended 2. No Christmas-like grads unassigned; Bullmas/CATEMAS absent. Check fails, left open.
- 2026-11-22 19:52 [d37fa1ed] Run 625: xmas Watching, grads 8/10 bar (6h 6>=3, creators 8>=6 met). Bullmas claimed by own rule theme bullmas (5 tok), not loose; CATEMAS/XMAS/HUSSMAS assignment unproven (needs assignGraduates replay). Rizzmas fake filter hits candidates only, not grads. Box 1 open: live wave below bar.
- 2026-11-22 19:57 [d37fa1ed] Run 626 (19:52:39Z): key xmas unchanged from 625, Watching, grads 8 (6h 6, creators 8). No meta_new_events for xmas/christ after 19:37:39Z. No bullmas key in 626. Box 3 stays open: key stable, but no-New-Meta is vacuous until xmas is a Meta.
- 2026-11-22 20:38 [d37fa1ed] Hourly check (Luis option 1): Haiku, read-only node:sqlite on /home/unknown/code/argus/.data/argus.db. If xmas is a Meta in meta_current: note grads/creators; next run: same key, no meta_new_events for it -> tick boxes 1, 3. Else write nothing.
