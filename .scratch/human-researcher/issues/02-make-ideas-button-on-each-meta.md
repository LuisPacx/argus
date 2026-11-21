# 02: "Make ideas" button on each Meta
**Model:** sonnet / medium — reuses the Operator-angle path (Meta redesign tickets 11 and 12) with the angle text made optional.

**What to build:** On each current Meta, a **Make ideas** button. One press files three meme Proposals about that Meta, by the same path the Operator angle uses, with no angle text required (an angle may still be typed). The Operator sees the ideas appear as ordinary meme Proposals. With the automatic Meta meme-ideas runs off (ticket 01), this button is the only way a Meta gets ideas. The existing caps apply: the angle allowance, the research budget, one waiting request per Meta.

**Blocked by:** 01 (same code: the automatic Meta trio is what 01 switches off)

**Status:** done

- [x] The button on `/meta` writes one request row with no angle text; the worker files three meme Proposals marked as pressed by the Operator (tested with a fake Brain).
- [x] A Meta that is no longer current is refused with the reason before any model call; a second press while one waits is refused (tests).
- [x] The angle allowance, the research budget and the 30-a-day new Proposals cap apply and end a request `capped` with the reason, never left waiting (tests).
- [ ] The War Room writes only the request row (test that no Proposal or other table changes on the press).
- [x] Render check with `pnpm page:check /meta` at 1240 and 390 px, keyboard focus on the button.
- [x] Type-check, `pnpm lint` and `pnpm check` are green.

## Comments
- 2026-11-20 cos: merged f409a64. Reviewer SHIP; verifier PASS 222 files / 3525 tests stamped c1bceb7f7e; page:check /meta exit 0 at 1240/390 with focus. Box 'writes only the request row' open: test covers Proposals/commands only.
