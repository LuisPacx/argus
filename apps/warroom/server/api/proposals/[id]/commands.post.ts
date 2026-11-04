import type { CommandType } from "@argus/core";

const types: CommandType[] = ["shortlist", "dismiss", "approve"];

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, "id"));
  if (!useStore().getProposal(id)) throw createError({ statusCode: 404, statusMessage: "Proposal not found" });
  const body = await readBody<{ type?: string; reason?: string }>(event);
  const type = types.find((t) => t === body?.type);
  if (!type) throw createError({ statusCode: 400, statusMessage: "Unknown command type" });
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (type === "dismiss" && !reason) throw createError({ statusCode: 400, statusMessage: "Dismissal needs a reason" });
  return useStore().enqueueCommand(id, type, reason);
});
