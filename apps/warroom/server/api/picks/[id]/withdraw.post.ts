import { PickWithdrawRefusedError } from "@argus/core";

/**
 * The Operator's "Withdraw" button on a Pick (human researcher ticket 10): for a mistyped contract address, within 10 minutes of making the Pick. The
 * server does the check whatever the page shows: an unknown id is 404; a Shadow pick, a Pick older than 10 minutes and a second withdrawal are 409 and
 * record nothing. Writes one withdrawal row and nothing else (the Pick is never changed); no model is called, no agent run starts (ADR 0017).
 */
export default defineEventHandler((event) => {
  const raw = getRouterParam(event, "id") ?? "";
  const id = /^[0-9]{1,9}$/.test(raw) ? Number(raw) : 0;
  if (id < 1) throw createError({ statusCode: 400, statusMessage: "The Pick id must be a number" });
  try {
    useStore().withdrawPick(id);
    return { pickId: id, withdrawn: true };
  } catch (e) {
    if (e instanceof PickWithdrawRefusedError) throw createError({ statusCode: e.code === "unknown" ? 404 : 409, statusMessage: e.message });
    throw e;
  }
});
