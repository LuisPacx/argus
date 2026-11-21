# 09: Operator step: open an X developer account, prepay, hand over the key
**Model:** none. This is the Operator's own checklist; no agent can or should do it (it spends his money and creates a credential).

**What this is:** the one thing stage B waits for. Every stage B ticket (10 to 14) is blocked until this is done. It is also a decision point: he reads stage A's scorecard first and only then pays.

**Status:** superseded

**Blocked by:** 05
Ticket 05 (the scorecard) must be built and stage A must have run its 14 days. Spec: section 8. ADR 0016, "Is paying for the X API a good choice?".

## Checklist for the Operator

Wording on X's console may differ from what is written here; the research read the pricing and Trends and Counts pages on 2026-11-19 and could not check the sign-up flow or whether a spending limit exists.

1. **Read the scorecard.** On `/radar`, open the Scorecard block after 14 days of stage A. It says "passes" or "does not pass" for the two stage A tests (spec 8):
   - stage A is worth keeping (at least 5 shown a day, at least 30 percent kept, at most 10 false flags a day, at most 2 wrong of 20 untokenized checks);
   - and at least half of the good subjects the radar missed (at least 5 of them, from your "Missed" entries) were first seen on X.
   If either does not pass, stop here: paying X adds a bill and no signal. Write the numbers in Comments and either fix the sources or stay on stage A.
2. **Say go.** Write "go B" with the date in Comments, plus the two caps you want in code (default: $3 a day, $90 over 30 days) and whether the automatic Watched topics of ticket 13 may use 2 of the 4 slots.
3. **Open an X developer account** (X's developer console) with an account that is **not** the Argus browser account. Reason (inferred): keep any developer-console action and API traffic away from the account the scanner and the Study are logged in as, so a problem on one cannot lock the other.
4. **Create an app and an app-only Bearer token with read access only.** No user-context keys, no write permission, no OAuth for any account. Read the pricing page once more and check the two prices below. If either differs, write the new price in Comments and stop; ticket 10 reads the live page and will not go on either.
   - Trends: $0.010 a request. Counts (recent): $0.005 a request. Both pay-per-use.
5. **Prepay a small amount first**, about a week of planned use: $20 (planned use is about $2.44 a day). If the console offers a spending limit or automatic top-up, set the limit or turn the top-up off. The prepaid balance is a hard stop beyond argus's own caps; keep it small until ticket 12's audit has run.
6. **Put the token in the repo-root `.env`** (git-ignored; check with `git check-ignore .env`) as one line `X_API_BEARER_TOKEN=<the token>`. Never paste it into a chat, a ticket, a commit or a log. File mode 600.
7. **Approve the key name.** Ticket 10 adds the exact name `X_API_BEARER_TOKEN` to the names `pnpm dev:start` reads from `.env` (today only `ARGUS_*` and `HELIUS_API_KEY`). Tick this box to approve that one name, or write a different name here:
   - [ ] I approve `X_API_BEARER_TOKEN` as the one new name.
8. **Tell the agent only:** "token is in `.env`, prepaid $<amount> on <date>". Then set this ticket's Status to `done`; tickets 10 to 14 become ready-for-agent.
9. **After a week of stage B:** run ticket 12's audit command, read its answer, and decide whether to prepay more or stop. Day 14 of stage B: read ticket 14's go-or-stop block.

## Acceptance (the Operator ticks)

- [ ] Stage A's 14-day scorecard was read and its two tests pass (numbers in Comments).
- [ ] "go B", the caps and the topics-slot answer are in Comments.
- [ ] The X developer account is open and is not the Argus browser account.
- [ ] A read-only app-only token exists; the two prices were checked.
- [ ] The prepaid amount is small (about $20) and any spending limit or top-up setting is as above.
- [ ] `X_API_BEARER_TOKEN` is in `.env`, git-ignored, and the name is approved (step 7).

## Comments
- 2026-11-21 cos triage: no paid X; X is read through the logged-in Argus Chrome profile (Operator, 2026-11-21)
