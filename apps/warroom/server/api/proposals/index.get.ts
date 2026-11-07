import { PROPOSAL_STATUSES, type CollisionStatus, type ProposalQuery, type ProposalSort, type ProposalStatus } from "@argus/core";
import { withResume } from "../../utils/resume.ts";
import { withScore } from "../../utils/score.ts";

const SORTS: readonly ProposalSort[] = ["score", "newest", "changed", "usage"];
const COLLISIONS: readonly CollisionStatus[] = ["clear", "collides", "unknown"];
const WINDOWS_MS: Record<string, number> = { "24h": 24 * 3_600_000, "7d": 7 * 24 * 3_600_000, "30d": 30 * 24 * 3_600_000 };
const bad = (what: string) => createError({ statusCode: 400, statusMessage: `Invalid ${what}` });
const one = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/**
 * The Proposals list, filtered and sorted in the datastore. Query: `sort` (score, newest, changed, usage; default score), `status`
 * (a Proposal status), `collision` (clear, collides, unknown), `created` (24h, 7d, 30d: created within that long).
 */
export default defineEventHandler((event) => {
  const q = getQuery(event);
  const query: ProposalQuery = {};
  const sort = one(q.sort);
  if (sort !== undefined) {
    if (!SORTS.includes(sort as ProposalSort)) throw bad("sort");
    query.sort = sort as ProposalSort;
  }
  const status = one(q.status);
  if (status !== undefined) {
    if (!PROPOSAL_STATUSES.includes(status as ProposalStatus)) throw bad("status");
    query.status = status as ProposalStatus;
  }
  const collision = one(q.collision);
  if (collision !== undefined) {
    if (!COLLISIONS.includes(collision as CollisionStatus)) throw bad("collision filter");
    query.collision = collision as CollisionStatus;
  }
  const created = one(q.created);
  if (created !== undefined) {
    if (!Object.hasOwn(WINDOWS_MS, created)) throw bad("created window");
    query.createdSince = new Date(Date.now() - WINDOWS_MS[created]!).toISOString();
  }
  const dataDir = useDataDir();
  const buildRoot = useBuildRoot();
  const store = useStore();
  return store.queryProposals(query).map((p) => withScore(store, withResume(p, dataDir, buildRoot)));
});
