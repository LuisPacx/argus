# 12: Research safety follow-ups
**Model:** sonnet / high — three security findings from the ticket 05 review, one of them about what the researcher may reach.

**What to build:** Three fixes to the research feature.

(a) Sources in a brief are third-party text, and a link could be a phishing address. Next to each source link the page shows the source's host plainly, so the Operator sees where it goes before clicking. Links open in a new tab without handing over the opener or the referrer. The page never presents a source as verified, checked or trusted: a source is only something the researcher said it read.

(b) The researcher reads the open web with its fetch tool, and a prompt-injected page or a hostile topic could steer it to the machine's own network. A research run refuses to fetch loopback addresses, private network ranges, link-local addresses and the War Room's own host. This is enforced where the run is started, in the model command's tool rules or in a guard the run passes through, not left to the prompt, and it holds for hostnames that resolve to those addresses where the guard can check that. Research stays Operator-triggered only (ADR 0017); this narrows what such a run may reach.

(c) The research run's X loads are recorded in the moment scans table under the label "research: <topic>". They stay recorded (cost and rate accounting needs them) but the Moments page must not show them as moments.

**Blocked by:** none

**Status:** done

- [x] Each source in a brief shows its host as plain text beside the link; a hostile source value (odd scheme, a host written to look like another, very long text) is shown escaped and cut, and a non-web link is not made clickable (render tests).
- [x] Source links open with no opener and no referrer, and no wording or badge anywhere says a source is verified (render test).
- [x] The research run's fetch rules refuse localhost, loopback, private ranges, link-local addresses and the War Room's own host, and a test proves a localhost URL is not allowed through the run's rules or guard (test on the built command or guard, no live call).
- [x] The same test covers an address written in an unusual form (for example a numeric or bracketed form) and a public address is still allowed (tests).
- [x] Research X loads recorded as "research: <topic>" stay in the moment scans table and do not appear on the Moments page; ordinary scans still do (test with both kinds of rows).
- [x] Type-check, `pnpm lint` and `pnpm check` are green.

## Comments
