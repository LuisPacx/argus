# 13: page:check gets its own output folder and port per run
**Model:** sonnet / medium — a small tool fix with a few edge cases.

**What to build:** `pnpm page:check` writes its screenshots to one shared folder and defaults to one fixed port, so agents working in parallel overwrite each other's screenshots and collide on the port. Each run gets its own output folder under the machine's temp area (the session temp location, never a fixed shared name), and the path is printed at the end so the caller can open the screenshots. When no port is given, the tool picks a free one itself; `--port` still works and is used as given. Old runs' folders are cleaned up or bounded, so the temp area does not fill (it is a small RAM-backed disk with a per-user quota). The worker rules mention the page check, so they are updated if they name the folder or the port.

**Blocked by:** none

Status: done

- [x] Two runs started at the same time write to two different output folders and neither overwrites the other's screenshots (test or scripted check).
- [x] The output folder is printed at the end of a run, including a run that fails.
- [x] With no `--port` the tool picks a free port, and two runs at once do not collide; with `--port` the given port is used (tests).
- [x] Old run folders are removed or capped at a stated number, and the current run's folder is never removed by its own cleanup (test).
- [x] Nothing is written to a fixed shared folder, and nothing outside the machine's temp area and the repo's usual ignored folders.
- [x] The worker rules and any other doc that names the old folder or port are updated to match.
- [x] Type-check, `pnpm lint` and `pnpm check` are green.

## Comments
