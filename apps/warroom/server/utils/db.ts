import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Datastore, type WarRoomStore } from "@argus/core";

let store: Datastore | undefined;

const dbPath = () => process.env.ARGUS_DB ?? resolve(process.cwd(), "../../.data/argus.db");

/** The data dir the worker writes under (`proposals/<id>/build.log`): the database's directory unless `ARGUS_DATA_DIR` says otherwise. */
export function useDataDir(): string {
  return process.env.ARGUS_DATA_DIR || dirname(resolve(dbPath()));
}

/** Where the Build repos live: the worker's `ARGUS_BUILD_ROOT`, else `~/code`. */
export function useBuildRoot(): string {
  return process.env.ARGUS_BUILD_ROOT || join(homedir(), "code");
}

/**
 * Shared datastore under the repo-root `.data/` (the same file the worker uses).
 * Typed narrowly: the War Room cannot reach `transition` or `resolveCommand`.
 */
export function useStore(): WarRoomStore {
  store ??= Datastore.open(dbPath());
  return store;
}
