# 02: Spike: a TikTok Source for viral videos (public data, no logged-in Chrome)
**Model:** sonnet / medium — a bounded spike: read what is publicly reachable, measure lead time on the DB, write findings. No production code.

**What to build:** a spike, not a Source. Decide whether viral TikTok videos (fast-rising views and likes, especially animals and characters) can become Signals from **public data without the Operator's logged-in Chrome**, and measure how much lead time a viral video gives over the first token carrying its name. Deliverable: one findings file, `.scratch/viral-sources/research/tiktok-feasibility-<date>.md`, with feasibility, rate limits and terms notes, the lead-time measurement and a go or no-go with the follow-up ticket outline. Chrome capture (ADR 0009 pattern) is the fallback only and out of scope here.

**Status:** ready-for-agent

**Blocked by:** nothing. Independent of tickets 01, 03, 04 and `warroom-redesign/03`. **Order (Operator priority, 2026-11-11): last** — viral-sources 03 Part A, 04 (Beta finder), warroom-redesign/03, 01, then this.

Origin: the Operator's idea "an animal going viral on TikTok is a repeatable edge", with the Misu example (`.scratch/cos.md`, "USER IDEA" and "MISU PROBE"): Misu (米苏, a sea lion, `@sealionmisu`, 11.8M views cited in the token's X post) was created on pump.fun 2026-11-08 04:59 UTC and bonded 11-10 23:52 UTC. Its video ids decode (`id >> 32`, unix seconds) to 11-02, 11-05 and 11-07 04:40 UTC: all before the create, the newest about 24 h before it and the oldest about 6 days before. Animal names alone do not predict migration (1.8% of animal-named tokens migrate against 2.8% overall, 11-09..11-11, crude regex), so the question is not "animals" but whether **a viral video is an early, specific, checkable Signal**.

## What the writer found in a short feasibility check (2026-11-11, six anonymous GETs, nothing logged in, no cookies)

- **TikTok Creative Center API** (the trending hashtags, creators and videos behind `ads.tiktok.com/business/creativecenter`): `GET https://ads.tiktok.com/creative_radar_api/v1/popular_trend/hashtag/list?...` answers HTTP 200 with `{"code":40101,"msg":"no permission"}`. The Creative Center page URL redirects to `https://ads.tiktok.com/creative/creativeCenter/trends`, a 21 KB single-page app whose data comes from that API; the app most likely sends signed or session headers that a plain GET does not. **Not reachable anonymously by a plain request.** Whether the app's own anonymous requests can be replayed was not tested, and reproducing request signing is out of bounds (see Constraints).
- **oEmbed** (`https://www.tiktok.com/oembed?url=<profile or video URL>`): works anonymously (HTTP 200, JSON). For a profile it returned title, author and embed HTML; per TikTok's documentation a video URL returns title, author and thumbnail. **It carries no view, like or share counts**, so it cannot detect virality; it can only resolve a URL a person already has (a creator named in a token's X post, for instance).
- **Profile pages** (`https://www.tiktok.com/@sealionmisu`): HTTP 200 but a 1.4 KB Slardar WAF challenge page to a plain client, no data. Reading counts from the page needs a real browser, which is the fallback this spike excludes.
- **`robots.txt`** (`https://www.tiktok.com/robots.txt`): `Disallow: /` for a long list of named AI crawlers and assistants, including `ClaudeBot`, `Claude-User`, `Claude-SearchBot`, `anthropic-ai`, `GPTBot`, `PerplexityBot`, `CCBot` and `Bytespider`; for other agents it allows `/discover`, `/tag`, `/foryou` and disallows `/search?`, `/search/video?`, `/discover/trending/detail/` and `/embed/@`. So an argus fetcher must not identify as, or hide behind, any of those names, and must not be built to evade the WAF or the robots rules. This is a note for the follow-up, not legal advice.
- **Not yet checked (the spike should settle them):** TikTok's Research API (access is, to the writer's knowledge, limited to approved researchers and not for commercial use; verify); the Display and Content APIs (OAuth, a user's own content; probably irrelevant); Creative Center terms of use; paid third-party scraping APIs (a new declared host, a paid account and their own terms; assess, do not adopt); whether the Creative Center pages list trending **videos** and not only hashtags and creators; and indirect public proxies for the same event.

## Constraints for the spike

- **ADR 0002 and hardening ticket 06.** Argus talks only to known hosts, reads only, holds no keys. Any production TikTok Source is a **fixed-host client (class a in ticket 06's inventory)**: its host(s) are a `declareClient` entry (for example `www.tiktok.com`, `ads.tiktok.com`, whichever the chosen path really needs), with an `ARGUS_TIKTOK_URL` style test mirror accepted only under vitest, redirects checked per hop, and no open-web fetching of whatever URL a response names. The spike's own requests are made by hand with `curl` or a throwaway script kept out of the argus processes (a script committed under `packages/core/scripts/` would need an exemption from ticket 06's lint rule; prefer not to commit one). If ticket 06 has not landed when the follow-up Source is built, follow today's pattern (`timedFetchText`) and the ticket 06 inventory gains the row.
- **Be a polite stranger.** At most 50 requests in total for the whole spike, spaced by at least 2 s, one generic honest `User-Agent` (`argus-spike/0.1`, no personal details, no browser impersonation), `robots.txt` honoured for the `*` agent, no login, no cookies, no tokens, **no reverse-engineering of request signing, no WAF challenge solving, no proxies or rotating IPs**. If the only way in is one of those, the finding is "no", with the evidence.
- **No Chrome capture, no X.** ADR 0009 (the dedicated logged-in browser for X) is the pattern for the fallback and is out of scope.
- **Untrusted data.** Anything fetched (captions, hashtags, names) is untrusted text; the spike's notes quote it only in code spans.
- Use glossary words: a viral video would be a **Signal** from a **Source**; the TikTok Source feeds **Narratives** (ticket 01 decides how a Signal joins one); it is not a **Meta** (the market's own naming, ticket 03).

## The measurement: lead time of a viral video over the first token of that name

Data on a `.backup` copy of `.data/argus.db` (`sqlite3 .data/argus.db ".backup <home-disk path>"`; never open the live file; delete the copy afterwards). Read it with `sqlite3` or a script in the scratchpad.
- **Coverage, stated first:** `signals` (PumpPortal creates and bonds) runs from 2026-11-06 18:28 UTC; `study_tokens` from 2026-11-09 00:54 UTC. The original Misu mint (`9oD9...ipump`, create 11-08 04:59) is in `signals` but **not** in `study_tokens`, so the lead-time query must take the **earliest create across both** (union by mint), not `study_tokens` alone.
- **Cases:** Misu as the sanity case (video times 11-02, 11-05, 11-07 against the first create 11-08 04:59 and the bond 11-10 23:52). Then as many further cases as public data allows within the request budget: viral animal or character videos from the period 11-06..11-12 that the spike can identify through whatever public path works (Creative Center pages that load, news or social posts naming a viral TikTok, the tokens' own X posts). If no public path yields a list of viral videos, the spike says so and the lead-time part uses only the cases found by hand (state how many).
- **For each case:** video post time (decode `id >> 32` for a video id), the time the video first looked viral if it can be known (otherwise say it cannot), the earliest matching token by normalised name or ticker among `signals` and `study_tokens` (reuse the name-match rules of ticket 03 slice 1 if it has landed, otherwise a stated crude one), lead = first create minus video time, and what the token did (migrated or not, unfiltered; copycat count).
- **Report:** the table, the distribution of lead times, how often a token existed before the video (negative lead), how often the first token was not the one that won, and the migration rate of matched tokens against the 2.8% base rate with its interval and n (expect n to be tiny; say so, do not extrapolate).
- **Cheaper proxy to check while there:** whether ticket 01/03's own launchpad signal (the count of same-name copycat creates) would have fired before the video-based one did, for Misu (first copycat 11-08 04:59 versus videos 11-02 to 11-07), and whether a non-TikTok Source argus could read without a login (Google Trends in the relevant country, a Chinese tech outlet's RSS such as the huxiu article the token's X post cites) would have shown Misu earlier than the create.

## Acceptance

- [ ] `.scratch/viral-sources/research/tiktok-feasibility-<date>.md` exists with: each public path tried (URL pattern, method, status, what came back, whether it is stable and anonymous), the requests count (at most 50), and a per-path verdict (usable, usable with a browser only, not usable).
- [ ] The file states rate limits observed or documented, `robots.txt` and terms findings with the lines quoted, and what identification a compliant fetcher must use; anything unverified is marked "unverified" and not asserted.
- [ ] The file states which host(s) a production Source would add to the egress allowlist (ticket 06 `declareClient`), how it would stay inside ADR 0002 (read-only, no keys), and what it would emit as a Signal (id scheme stable per video and per threshold crossing so a rising video is not duplicated, title that leads with the subject so ticket 01 can link it, summary with the counts, url through the safe-link rules).
- [ ] The lead-time table is in the file, with the coverage statement, the Misu sanity case, every other case with its inputs, the distribution, and the migration comparison with n and an interval. The query or script used is in the file so it can be rerun.
- [ ] The file ends with a go, no-go or fallback-only recommendation and, for a go, the follow-up ticket outline (client, polling interval, volume cap, threshold for "viral", tests with recorded fixtures); for a no-go, the cheaper proxies that came out of the measurement.
- [ ] No code changed under `packages/` or `apps/`; no new dependency; the DB copy and any scratch files are deleted; no request was made that the constraints forbid.

## Interplay

- **Ticket 06 (egress)** and **ADR 0002** are constraints, above. **ADR 0009** (X capture through a dedicated logged-in browser) is the fallback pattern, not used here.
- **Ticket 01** decides how a TikTok Signal joins a launchpad Narrative (a shared distinctive name or ticker, since a social headline and a create score only 0.81 to 0.90 by embedding); this spike's follow-up must put the subject first in the Signal title for that rule.
- **Ticket 03 / 04** (Metas, Betas): a TikTok Source is an input to a Narrative, not to a Meta; it may later add early evidence for a Beta, not now.
- **Live run:** a 48 h run uses the main checkout and `.data/argus.db`; only a `.backup` copy is read.

## Open questions for the Operator

1. **How much is a "no" worth?** If every anonymous path is closed, is the Chrome capture fallback (a logged-in TikTok profile) something you want ticketed, given ADR 0009's X profile already exists?
2. **Paid third-party data.** Allowed to assess a paid scraping API (a new host, a paid account, their terms) as an option, or strictly free and public?

## Commits

One commit, docs only (the findings file and the ticket's ticked boxes). Subject `Viral sources ticket 02: <what changed>`, body ending with `Ticket: .scratch/viral-sources/issues/02-tiktok-source-spike.md` before the trailers. No `Closes #N`: this repo has no GitHub issues.

## Comments
