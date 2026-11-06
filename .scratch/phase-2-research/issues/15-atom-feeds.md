# 15: Atom feeds in the RSS Source
**Model:** sonnet / medium — one parser extension plus a recorded fixture.

**What to build:** The configured feed `rss:verge` returned 0 items in a live poll because The Verge serves Atom (`<feed>`/`<entry>`, `<link href=...>`, `<updated>`), which the RSS Source did not parse. The RSS Source parses Atom too, with the same bounds as RSS.

**Blocked by:** none

**Status:** done

- [x] Cause confirmed by one live fetch of the Verge feed URL; a trimmed real sample is kept as a fixture
- [x] `<entry>` is parsed like `<item>`: title, link, summary (falling back to content), published (falling back to updated), id
- [x] A link is `rel="alternate"` or has no `rel`; its href goes through `safeUrl` and entity decoding
- [x] `type="html"` titles have their tags stripped
- [x] Same bounds as RSS: byte cap, item cap, field truncation (feed content is untrusted, CODING_STANDARDS rule 13)
- [x] Every existing RSS test stays green; fixture-based Atom tests, no network
- [x] Other configured feeds checked by root element: all RSS
- [x] `pnpm check` passes
