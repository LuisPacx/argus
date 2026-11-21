/**
 * The Scoreboard (human researcher ticket 08): the Operator's and the machine's bonded-within-24h rate over the last 7 days, each with n, the topics
 * compared, the rows left out of the comparison and a verdict that stays "not enough Picks yet" until each side has 20 finished Picks. Computed by
 * plain code from the Picks and their outcome rows. Read only: nothing here calls a model or writes a row.
 */
export default defineEventHandler(() => useStore().scoreboard(new Date()));
