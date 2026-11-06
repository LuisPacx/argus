# 06: Rubric as editable data
**Model:** sonnet / medium — data plus an editor over existing seams.

**What to build:** The Operator edits the Rubric (dimension descriptions, weights, buildability gate) in the War Room. It is stored in the datastore, not in code, seeded with momentum, novelty, buildability (hard gate), hook and legitimacy at equal weights.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] The Rubric is stored in the datastore and seeded with the five v1 dimensions at equal weights, with buildability as the hard gate
- [x] The War Room editor saves descriptions, weights and the gate; invalid input is refused with a message; endpoint-level tests with the exact UI payload
- [x] Rubric changes are versioned, so each Score can record the Rubric version it used
- [x] `pnpm check` passes
