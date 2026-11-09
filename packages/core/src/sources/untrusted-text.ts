import { safeUrl, stripHtml } from "./rss.ts";

/**
 * The sanitising rules for text that comes from a remote party, shared by the PumpPortal Source and the Study's Snapshots:
 * markup removed, trimmed, cut to `max`; anything that is not a string becomes the empty string; links must be http(s) and not over-long.
 */
export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const cleanText = (v: unknown, max: number): string => (typeof v === "string" ? stripHtml(v).trim().slice(0, max) : "");

/** An http(s) link as the Source rules allow it, or "" (see `safeUrl`). */
export const cleanLink = (v: unknown): string => (typeof v === "string" ? safeUrl(v.trim()) : "");
