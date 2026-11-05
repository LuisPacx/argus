# 16: Containment verification (`verify:contain`) and `verify:boot` extension
**Model:** sonnet / medium — scripted checks against real podman and the dry-run output.

**What to build:** `scripts/verify-contain.mjs` per section 9 (SKIP with reason when podman or the image is missing), and the `verify:boot` additions (required `podman run` flags, forbidden substrings).

**Blocked by:** 15

**Status:** done

- [x] `pnpm verify:contain` passes on this host with the image built; every HIGH2 and MED4 bullet in the reviewer's list has a corresponding check
- [x] Skips cleanly (exit 0, prints SKIP) without podman; never pulls or builds (SKIP path checked by verifier on 363919e)
- [x] `pnpm verify:boot` passes and fails if the dry run drops a required flag or adds `--privileged`
- [x] `pnpm check` passes
