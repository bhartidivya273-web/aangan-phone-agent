import type { VoiceAdapter } from "./types";
import { stubAdapter } from "./stub";
import { vaaniAdapter } from "./vaani";

/**
 * Register provider adapters here. Select one with VOICE_PROVIDER (default "stub").
 * Adding a provider = one new file implementing VoiceAdapter + one line below. Nothing else changes.
 */
const ADAPTERS: Record<string, VoiceAdapter> = {
  [stubAdapter.name]: stubAdapter,
  [vaaniAdapter.name]: vaaniAdapter,
};

export function getAdapter(name: string = process.env.VOICE_PROVIDER ?? "stub"): VoiceAdapter {
  const a = ADAPTERS[name];
  if (!a) throw new Error(`Unknown VOICE_PROVIDER "${name}". Registered: ${Object.keys(ADAPTERS).join(", ")}`);
  return a;
}
