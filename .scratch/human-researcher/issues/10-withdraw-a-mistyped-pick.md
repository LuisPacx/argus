# 10: Withdraw a mistyped Pick
**Model:** sonnet / medium — one write-once record, one guarded endpoint and a button.

**What to build:** The Operator can withdraw his own Pick within 10 minutes of making it, for the case of a mistyped contract address. The Pick itself is never deleted or edited: the no-update, no-delete guarantee on Picks stays. A withdrawal is a separate write-once record (or an equivalent that leaves the Pick row untouched) that says which Pick was withdrawn and when. A withdrawn Pick no longer counts anywhere: not in the bonded-within-24h rates, not in the Scoreboard, not as an input to a Playbook rebuild or its 10-Pick minimum. On the Research page it stays visible, shown struck through, so the Operator sees what he withdrew. Within the 10 minutes each of his Picks has a Withdraw button; after that the button is gone and the server refuses the withdrawal with a 409, whatever the page shows. Shadow picks cannot be withdrawn. Withdrawing is the Operator's own click and starts no agent run (ADR 0017).

**Blocked by:** none

Status: done

- [x] Withdrawing an Operator Pick within 10 minutes records a withdrawal; the Pick row is unchanged, and an update or delete of a Pick or of a withdrawal is still refused by the database (tests).
- [x] After 10 minutes the server refuses with a 409 and records nothing; withdrawing the same Pick twice is refused too; an unknown Pick id is refused (tests with a controlled clock).
- [x] A Shadow pick cannot be withdrawn: the server refuses it and the page shows no button on it (tests).
- [x] A withdrawn Pick is excluded from the bonded-within-24h rate, the Scoreboard counts and the Playbook inputs, including the 10-Pick minimum, and no new outcome job is wasted on it (tests with a withdrawn Pick among others).
- [x] The Research page shows a withdrawn Pick struck through, shows the Withdraw button only on the Operator's Picks younger than 10 minutes, and shows no button afterwards (render tests).
- [x] Withdrawing writes only the withdrawal record and calls no model (test).
- [x] Render check with `pnpm page:check /research` at 1240 and 390 px, keyboard: focus the Withdraw button, press Enter. (verifier: plain page:check exit 0; keys run failed only on the blocked withdraw POST, proving Enter activates it)
- [x] Type-check, `pnpm lint` and `pnpm check` are green.

## Comments
