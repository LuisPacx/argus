import { InvalidEvidenceLinkError, normalizeEvidenceLinks, type NewProposal } from "@argus/core";

const textFields = ["narrativeSummary", "techOneLiner", "whyNow", "name", "ticker", "description"] as const;

export default defineEventHandler(async (event) => {
  const body = await readBody<Record<string, unknown>>(event);
  const fields = {} as Record<(typeof textFields)[number], string>;
  for (const key of textFields) {
    const value = body?.[key];
    if (typeof value !== "string" || value.trim() === "") {
      throw createError({ statusCode: 400, statusMessage: `${key} is required` });
    }
    fields[key] = value.trim();
  }
  let evidenceLinks: string[];
  try {
    evidenceLinks = normalizeEvidenceLinks(Array.isArray(body?.evidenceLinks) ? body.evidenceLinks : []);
  } catch (e) {
    if (e instanceof InvalidEvidenceLinkError) throw createError({ statusCode: 400, statusMessage: e.message });
    throw e;
  }
  const input: NewProposal = { ...fields, evidenceLinks };
  return useStore().createProposal(input);
});
