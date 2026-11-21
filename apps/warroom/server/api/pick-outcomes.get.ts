/** What became of the Operator's Picks (human researcher ticket 04): the outcome of each of the newest Picks and the bonding rate over all of them. Read only. */
export default defineEventHandler(() => useStore().pickOutcomes(new Date()));
