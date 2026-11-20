# 07: Radar suggestions on the Research page
**Model:** sonnet / medium — a read-only list that fills a form field.

**What to build:** The Research page lists the current Trends from the radar as suggestions. Clicking one fills the topic box with its name. Nothing runs until the Operator submits the form himself. This replaces the radar's own "Make ideas from a Trend" button.

**Blocked by:** 05

**Status:** ready-for-agent

- [ ] The page lists the live named Trends, newest first, with their score and sources, and says "no Trends right now" when there are none (render test).
- [ ] Clicking a suggestion sets the topic box to the Trend's plain subject and starts nothing: no request row is written until submit (test).
- [ ] Trend text is third-party: shown escaped and cut; a hostile subject is one escaped line (render test).
- [ ] The page reads the radar tables and writes nothing; a GET leaves every table unchanged (test).
- [ ] Render check with `pnpm page:check /research` at 1240 and 390 px, keyboard: focus a suggestion, press Enter.
- [ ] Type-check, `pnpm lint` and `pnpm check` are green.

## Comments
