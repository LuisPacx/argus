import { DexScreenerClient } from "@argus/core";

let client: DexScreenerClient | undefined;

/** The one read-only DexScreener client the War Room uses (coin lookups for Picks). A test stubs this name. */
export function useDexClient(): DexScreenerClient {
  client ??= new DexScreenerClient();
  return client;
}
