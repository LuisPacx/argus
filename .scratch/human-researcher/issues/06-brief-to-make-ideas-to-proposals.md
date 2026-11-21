# 06: Brief to Make ideas to Proposals
**Model:** sonnet / medium — generalizes an existing path; the checks and caps are reused.

**What to build:** Under each Research brief a **Make ideas** button. One press files three meme Proposals keyed to the topic, through the same path as a Meta's Make ideas, now written to take "a Meta or a topic". The brief's coins and free names feed the names to avoid. The copy check against live coins and the repair retry are reused, not rewritten. Each Proposal shows it came from a topic and links back to the brief.

**Blocked by:** 02, 05

**Status:** done

- [x] The button writes one request row for the brief; the worker files three `meme` Proposals keyed to the topic with a source marker readers can branch on; older Proposals still read (tests with a fake Brain).
- [x] The brief and topic go in as a fenced untrusted block under a fresh boundary; names to avoid include the brief's existing coins; a copied live-coin name is refused once with the names listed (tests).
- [x] Caps: the angle allowance, the research budget and the 30-a-day cap apply; a second request for the same brief inside 24 hours is refused; the request ends `done`, `refused`, `failed` or `capped` with the reason (tests).
- [x] The Proposal page and card show the topic source and a link to the brief (render test, `pnpm page:check` seeded).
- [x] The Meta path from ticket 02 behaves exactly as before (its tests unchanged).
- [x] Type-check, `pnpm lint` and `pnpm check` are green.

## Comments
