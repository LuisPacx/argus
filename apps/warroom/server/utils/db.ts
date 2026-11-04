import { resolve } from "node:path";
import { Datastore, type WarRoomStore } from "@argus/core";

let store: Datastore | undefined;

/**
 * Shared datastore under the repo-root `.data/` (the same file the worker uses).
 * Typed narrowly: the War Room cannot reach `transition` or `resolveCommand`.
 */
export function useStore(): WarRoomStore {
  store ??= Datastore.open(process.env.ARGUS_DB ?? resolve(process.cwd(), "../../.data/argus.db"));
  return store;
}
