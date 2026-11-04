import type { NewProposal } from "@argus/core";

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
  const links = body?.evidenceLinks;
  const evidenceLinks = Array.isArray(links)
    ? links.filter((l): l is string => typeof l === "string").map((l) => l.trim()).filter(Boolean)
    : [];
  const input: NewProposal = { ...fields, evidenceLinks };
  return useStore().createProposal(input);
});
