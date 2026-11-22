# 05: Topic to Research brief
**Model:** sonnet / high — a new researcher skill that reads untrusted Operator text and X, with a cost cap; the trust boundary needs care.

**What to build:** On the Research page the Operator types a topic (for example "GTA") and presses Research. A request row is written; the worker runs a researcher agent that reads the web, reads X only through the existing logged-in session path (never a bundled Chromium) and looks coins up on DexScreener. The result is stored as a Research brief and shown on the page: the story, its sources, the existing coins on the topic with market cap and bonded state, and names still free. There is a daily cap and a per-run cap; the Operator sees the cost of each run.

**Blocked by:** 03

Status: done

- [x] A topic submit writes one request row and nothing else; the War Room writes no brief (test); empty, oversized, wrong-typed or extra-key bodies are 400 with nothing stored.
- [x] The worker claims the row and runs the researcher skill with the topic in one fenced block under a fresh random boundary, flattened and cut, named untrusted; a hostile topic, a forged boundary line and 100,000 characters of text cannot end the block or add an instruction (tests with a fake Brain).
- [x] X is read only through the existing session path; a test fails if the researcher code launches a browser of its own or reaches a host not already declared.
- [x] The stored brief has story, sources (links kept only if `http` or `https`), coins with cap and bonded state, and free names; a malformed output gets one repair retry and then ends `failed` with the reason (tests).
- [x] A daily cap and a per-run cap are in code and not raisable by configuration; a capped request ends `capped` with the reason and is never left waiting; a rate limit or shutdown leaves it waiting (tests).
- [x] Every run records its cost in `brain_runs`, and the page shows it (test).
- [x] The skill file for the researcher is added with a dry-run that shows the rendered prompt.
- [x] Render check with `pnpm page:check /research`, seeded if needed, at 1240 and 390 px; type-check, `pnpm lint` and `pnpm check` are green.

## Comments
