/**
 * The Operator's last 20 angle requests (meta redesign ticket 11), newest first, for the form on /meta: each has its Meta key, status
 * (`pending`, `running`, `done`, `refused`, `failed`, `capped`), the reason in words, its times and the Proposal ids the worker filed. Never the
 * angle text or its link: the page does not need them back. Read only.
 */
export default defineEventHandler(() => useStore().memeAngleRequests());
