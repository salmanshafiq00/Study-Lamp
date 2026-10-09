import type { AiLanguage } from "@/lib/ai/types";

/**
 * Per-picker language override logic (pure, so it is unit-testable).
 *
 * The saved default lives in Settings -> AI. Each AI trigger has its own
 * picker, which starts on the default; picking a different language overrides
 * ONLY that picker's next generation and never changes the saved default.
 */

/** A picker that was never manually changed follows the saved default. */
export function resolveEffectiveLanguage(defaultLanguage: AiLanguage, override: AiLanguage | null): AiLanguage {
  return override ?? defaultLanguage;
}

/** Choosing the default language again is the same as "no override", so the picker keeps following the default. */
export function nextOverride(defaultLanguage: AiLanguage, picked: AiLanguage): AiLanguage | null {
  return picked === defaultLanguage ? null : picked;
}

/**
 * The `language` to put in an AI request. If the saved default could not be
 * loaded and the user has not picked a language by hand, send NOTHING, so the
 * server falls back to the saved default instead of being overridden by the
 * client's placeholder "en".
 */
export function resolveRequestLanguage(input: {
  defaultLanguage: AiLanguage;
  override: AiLanguage | null;
  loadFailed: boolean;
}): AiLanguage | undefined {
  if (input.loadFailed && input.override === null) return undefined;
  return resolveEffectiveLanguage(input.defaultLanguage, input.override);
}

export function isLanguageOverridden(defaultLanguage: AiLanguage, override: AiLanguage | null): boolean {
  return override !== null && override !== defaultLanguage;
}

export const AI_LANGUAGE_LABELS: Record<AiLanguage, string> = {
  en: "EN",
  bn: "BN",
};
