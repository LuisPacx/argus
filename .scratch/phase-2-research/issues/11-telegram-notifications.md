# 11: Telegram notifications
**Model:** sonnet / medium — a notify-only integration with failure isolation.

**What to build:** One bot posts to one Team chat: new Proposal cards, build start, build done (with the preview link) and build failed. Notify only; no commands and no reply-to-approve.

**Blocked by:** Phase 1 ticket 07 (Build Runner happy path)

**Status:** done

- [x] The bot token and chat id come from the git-ignored `.env` and are never logged; missing config disables notifications with one warning
- [x] Messages for new Proposal, build start, build done (with the preview link) and build failed
- [x] Send failures are retried with backoff and never block the worker tick or a Build
- [x] Dry-run logs the message instead of sending it
- [x] Tests use a fake Telegram API; no network
- [x] `pnpm check` passes
