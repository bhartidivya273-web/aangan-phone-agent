import { getConfig } from "./config";
import { SupabaseStore, type Store } from "./store";
import { chatsFromEnv, notifierFromEnv } from "./telegram";
import type { ProcessDeps } from "./pipeline";

/** Wires production dependencies from env. Routes call this; tests build their own deps. */
export function productionDeps(): ProcessDeps & { store: Store } {
  return {
    cfg: getConfig(),
    store: SupabaseStore.fromEnv(),
    notifier: notifierFromEnv(),
    chats: chatsFromEnv(),
  };
}
