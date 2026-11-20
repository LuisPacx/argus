/** The Operator's newest Picks (human researcher ticket 03), newest first, each with its snapshot, reason and topic. Read only. */
export default defineEventHandler(() => useStore().listPicks());
