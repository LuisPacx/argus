/** Per-Source health: last poll, last success, last error and Signals ingested in the rolling 24 h. Read-only. */
export default defineEventHandler(() => useStore().sourceHealth());
