import { dirname, resolve } from "node:path";
import { Datastore, type WarRoomStore } from "@argus/core";

let store: Datastore | undefined;

const dbPath = () => process.env.ARGUS_DB ?? resolve(process.cwd(), "../../.data/argus.db");

/** The data dir the worker writes under (`proposals/<id>/build.log`): the database's directory unless `ARGUS_DATA_DIR` says otherwise. */
export function useDataDir(): string {
  return process.env.ARGUS_DATA_DIR || dirname(resolve(dbPath()));
}

/**
 * Shared datastore under the repo-root `.data/` (the same file the worker uses).
 * Typed narrowly: the War Room cannot reach `transition` or `resolveCommand`.
 */
export function useStore(): WarRoomStore {
  store ??= Datastore.open(dbPath());
  return store;
}
