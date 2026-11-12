import { MAX_REVISE_INSTRUCTION_CHARS, cleanupPlan, cleanupRefusal, isMintAddress, type CommandType } from "@argus/core";

const types: CommandType[] = ["shortlist", "undo-shortlist", "dismiss", "approve", "revise", "retry-spec", "requeue", "mark-launched", "cleanup-build"];

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
    const other = useStore().proposalIdWithMint(reason);
    if (other !== null && other !== id) {
      throw createError({ statusCode: 409, statusMessage: `That mint is already recorded on Proposal ${other}; each token belongs to one Proposal` });
    }
  }
  // Clean up build deletes things outside argus. The worker decides; this is fast feedback, and the typed repo name of a legacy Build
  // travels in `reason` (checked again by the worker, which deletes nothing for a name that does not match).
  if (type === "cleanup-build") {
    const refusal = cleanupRefusal(useStore(), proposal, useBuildRoot());
    if (refusal !== null) throw createError({ statusCode: 409, statusMessage: refusal });
    const { repo } = cleanupPlan(proposal, useBuildRoot());
    if (repo.legacy && reason !== repo.name) {
      throw createError({ statusCode: 400, statusMessage: `This Build's repo was not recorded: type ${repo.name} to confirm deleting it` });
    }
    return useStore().enqueueCommand(id, type, repo.legacy ? reason : "");
  }
  // Fast feedback only; the worker re-checks when it applies the command.
  if (type === "undo-shortlist" && proposal.status !== "shortlisted" && proposal.status !== "spec-drafted") {
    throw createError({ statusCode: 409, statusMessage: `Undo shortlist is only possible while the Proposal is shortlisted or spec-drafted (it is ${proposal.status})` });
  }
  if (type === "revise" && proposal.brainRunInFlightSince) {
    throw createError({ statusCode: 409, statusMessage: "A brain run is in flight for this Proposal; try again when it finishes" });
  }
  return useStore().enqueueCommand(id, type, reason);
});
