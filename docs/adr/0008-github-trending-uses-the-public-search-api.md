# GitHub trending is read from the public search API, not scraped

Status: accepted (Phase 2 ticket 04). Closes the open question in architecture section 13.

github.com/trending has no API, so it can only be read by scraping its HTML, which GitHub does not offer as a supported interface and which breaks whenever the markup changes. Argus instead uses GitHub's documented REST search, `GET https://api.github.com/search/repositories?q=created:>{7 days ago}&sort=stars&order=desc&per_page=30`: repositories created in the last week with the most stars. That is a proxy for "trending", not the same list: it misses older repositories that surge, and favours new ones.

Access: keyless and unauthenticated, no account, token or paid plan, and within the published terms. Rate limit: unauthenticated search is 10 requests per minute per IP (60 per hour for the rest of the REST API). One poll is one request, made on the 5 minute ingest tick, so the limit is never approached. A request is sent with an `accept` header and a `user-agent`, which GitHub requires. Keyless means the source stays optional: no secret is added to `.env`.

The Source is `GitHubTrendingSource` (`packages/core/src/sources/github-trending.ts`), wrapped in `BackoffSource` like the other standing Sources, so a 403 or 429 (rate limit) backs off and honours Retry-After. One Signal per repository, id `github:trending:{owner/name}` lower-cased, so a repo that stays on the list is stored once. Text from the response is untrusted: markup is stripped, lengths are capped, names must be plain `owner/name` tokens and the link must be http(s).

How it can break:
- The response layout changes (no `items` array, or none of the returned entries has a readable `full_name`): the poll throws and logs `[github-trending] layout check failed`, and the ingest tick reports the Source as failed. It never silently yields zero Signals. An honestly empty result (no entries) is not an error.
- Rate limiting or an outage: 403, 429 and 5xx are errors; backoff applies. GitHub's primary limit answers 403 with `x-ratelimit-remaining: 0` and `x-ratelimit-reset` (epoch seconds) instead of Retry-After; `timedFetchText` turns that into `retryAfterMs` up to the reset, clamped to the same hour as Retry-After.
- The search index lags, and `sort=stars` can show repositories with bought stars. Signals are evidence only; the judge decides.
- Search returns at most 1,000 results and we read 30, which is enough for a first page.
