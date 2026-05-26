/**
 * Model tier abstraction.
 *
 * Skills declare a tier (`fast` / `balanced` / `smart`) instead of
 * a specific model id. A global "speed bias" preference in
 * config.json adjusts every tier in one place — bump everything
 * down to fast for snappy responses, or up to smart when you need
 * the reasoning. Explicit `model:` in a skill's frontmatter still
 * wins over the tier system for cases where you really do want to
 * pin a specific model.
 *
 * The tier→model map is the single point of truth; updating model
 * versions (haiku-4-6, etc.) is a one-line edit here, not a sweep
 * across every skill.
 */

export type ModelTier = 'fast' | 'balanced' | 'smart';

/**
 * Tier → model id. Pin specific versions so behaviour is
 * reproducible. Bump these when new model releases ship + you've
 * validated the swap.
 */
export const TIER_MODELS: Record<ModelTier, string> = {
  fast: 'claude-haiku-4-5',
  balanced: 'claude-sonnet-4-5',
  smart: 'claude-opus-4-1',
};

/**
 * Global preference. `auto` respects each skill's declared tier;
 * the rest shift or clamp it. Defaults to `auto`.
 *
 *   prefer-fast    — anything balanced becomes fast; smart becomes
 *                    balanced. Use when you want snappier responses
 *                    everywhere without forcing haiku on tasks that
 *                    genuinely need opus.
 *   prefer-smart   — symmetric the other way.
 *   force-<tier>   — hard override; every skill runs at this tier.
 */
export type SpeedBias =
  | 'auto'
  | 'prefer-fast'
  | 'prefer-smart'
  | 'force-fast'
  | 'force-balanced'
  | 'force-smart';

export const DEFAULT_SPEED_BIAS: SpeedBias = 'auto';
export const DEFAULT_TIER: ModelTier = 'balanced';

/** Order used by `prefer-fast` / `prefer-smart` shifts. */
const TIER_ORDER: ModelTier[] = ['fast', 'balanced', 'smart'];

/**
 * Resolve the effective tier from a skill's declared tier (or
 * undefined → DEFAULT_TIER) plus the user's bias. Stays in
 * { fast | balanced | smart } — no surprise tiers.
 */
export function resolveTier(
  skillTier: ModelTier | null | undefined,
  bias: SpeedBias = DEFAULT_SPEED_BIAS,
): ModelTier {
  const base = skillTier ?? DEFAULT_TIER;
  switch (bias) {
    case 'force-fast':
      return 'fast';
    case 'force-balanced':
      return 'balanced';
    case 'force-smart':
      return 'smart';
    case 'prefer-fast': {
      const idx = TIER_ORDER.indexOf(base);
      return TIER_ORDER[Math.max(0, idx - 1)] ?? 'fast';
    }
    case 'prefer-smart': {
      const idx = TIER_ORDER.indexOf(base);
      return TIER_ORDER[Math.min(TIER_ORDER.length - 1, idx + 1)] ?? 'smart';
    }
    case 'auto':
    default:
      return base;
  }
}

/** Map a tier to its concrete model id. */
export function modelForTier(tier: ModelTier): string {
  return TIER_MODELS[tier];
}

/** Coerce arbitrary input to a ModelTier or null. Used when parsing
 *  YAML frontmatter where the user may have typo'd the value. */
export function asTier(raw: unknown): ModelTier | null {
  if (raw !== 'fast' && raw !== 'balanced' && raw !== 'smart') return null;
  return raw;
}

/** Coerce arbitrary input to a SpeedBias or default. */
export function asSpeedBias(raw: unknown): SpeedBias {
  switch (raw) {
    case 'auto':
    case 'prefer-fast':
    case 'prefer-smart':
    case 'force-fast':
    case 'force-balanced':
    case 'force-smart':
      return raw;
    default:
      return DEFAULT_SPEED_BIAS;
  }
}
