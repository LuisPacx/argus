import { MAX_REVISE_INSTRUCTION_CHARS, isMintAddress, type CommandType } from "@argus/core";

const types: CommandType[] = ["shortlist", "dismiss", "approve", "revise", "retry-spec", "requeue", "mark-launched"];

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, "id"));
  const proposal = useStore().getProposal(id);
  if (!proposal) throw createError({ statusCode: 404, statusMessage: "Proposal not found" });
  const body = await readBody<{ type?: string; reason?: string }>(event);
  const type = types.find((t) => t === body?.type);
  if (!type) throw createError({ statusCode: 400, statusMessage: "Unknown command type" });
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (type === "dismiss" && !reason) throw createError({ statusCode: 400, statusMessage: "Dismissal needs a reason" });
  if (type === "revise" && !reason) throw createError({ statusCode: 400, statusMessage: "Revise needs an instruction" });
  if (type === "revise" && reason.length > MAX_REVISE_INSTRUCTION_CHARS) {
    throw createError({ statusCode: 400, statusMessage: `Revise instruction is over ${MAX_REVISE_INSTRUCTION_CHARS} characters` });
  }
  // Mark launched carries the mint in `reason`. Format only; argus never asks a chain (ADR 0002).
  if (type === "mark-launched") {
    if (!isMintAddress(reason)) throw createError({ statusCode: 400, statusMessage: "Enter a Solana mint address (base58, 32 to 44 characters)" });
    if (proposal.status !== "built" && proposal.status !== "launched") {
      throw createError({ statusCode: 409, statusMessage: `Mark launched needs a built Proposal (it is ${proposal.status})` });
    }
  }
  // Fast feedback only; the worker re-checks when it applies the command.
  if (type === "revise" && proposal.brainRunInFlightSince) {
    throw createError({ statusCode: 409, statusMessage: "A brain run is in flight for this Proposal; try again when it finishes" });
  }
  return useStore().enqueueCommand(id, type, reason);
});
