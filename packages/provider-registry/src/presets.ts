import type { ProviderProtocol } from "./types.js";

/**
 * A built-in provider template.
 *
 * Presets describe protocol and endpoint only. They never carry an API key, a
 * token, an Authorization header, extra headers or any other secret, and they
 * are never auto-registered or auto-enabled in a registry.
 */
export interface ProviderPreset {
  readonly id: string;
  readonly name: string;
  readonly protocol: ProviderProtocol;
  readonly baseUrl: string;
}

/**
 * Frozen template list. Model names are intentionally omitted so that presets
 * never pin a concrete model version.
 */
const OFFICIAL_PROVIDER_PRESETS: readonly ProviderPreset[] = Object.freeze([
  Object.freeze({
    id: "anthropic-official",
    name: "Anthropic",
    protocol: "anthropic_messages",
    baseUrl: "https://api.anthropic.com",
  }),
  Object.freeze({
    id: "openai-official",
    name: "OpenAI",
    protocol: "openai_compatible",
    baseUrl: "https://api.openai.com/v1",
  }),
]);

/**
 * Returns a fresh copy of the official presets on every call.
 *
 * The internal template list stays deeply frozen; callers receive their own
 * mutable objects and array, so mutating a returned value can never affect a
 * later call.
 */
export function getOfficialProviderPresets(): readonly ProviderPreset[] {
  return OFFICIAL_PROVIDER_PRESETS.map((preset) => ({
    id: preset.id,
    name: preset.name,
    protocol: preset.protocol,
    baseUrl: preset.baseUrl,
  }));
}
