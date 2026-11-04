import { resolve } from "node:path";
import { Datastore } from "@argus/core";

let store: Datastore | undefined;

/** Shared datastore under the repo-root `.data/` (the same file the worker uses). */
export function useStore(): Datastore {
  store ??= Datastore.open(process.env.ARGUS_DB ?? resolve(process.cwd(), "../../.data/argus.db"));
  return store;
}
