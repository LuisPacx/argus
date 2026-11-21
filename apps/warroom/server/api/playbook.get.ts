/**
 * The Playbook (human researcher ticket 09): every version newest first (the last 10; an old one stays readable in the database), the latest rebuild
 * requests with their cost, how many finished Picks a rebuild would read and whether a press would be accepted now (and why not). The lessons were written
 * by a model from the Operator's own Picks and are shown as escaped text. Read only: nothing here calls a model or writes a row.
 */
export default defineEventHandler(() => useStore().playbookState());
