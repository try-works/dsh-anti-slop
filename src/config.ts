/**
 * dsh-anti-slop plugin configuration (Schemastery `Config`).
 *
 * The config drives the `anti_slop_lint` tool defaults and the standing
 * prompt-section text. All fields are optional in the declared interface;
 * the schemastery `Config` supplies defaults for every field.
 *
 * @module dsh-anti-slop/src/config
 */

import z from '@deepseek-ai/schemastery'

/** Severity a rule finding maps to when the tool builds oxlint argv. */
export type AntiSlopSeverity = 'error' | 'warn' | 'off'

/** Default tool timeout (60s). */
export const DEFAULT_TIMEOUT_MS = 60_000

/** Rules enabled by default: every generic anti-slop rule. */
export const DEFAULT_ENABLED_RULES = [
  'no-chained-type-assertions',
  'no-conditional-empty-object-spread',
  'no-known-value-widening',
  'no-module-mocking',
  'no-object-parameters',
  'no-reflect-apply',
  'no-reflect-get',
  'no-runtime-typeof',
  'no-shape-in-symbol-names',
  'no-unknown-parameters',
  'no-unknown-returns',
  'no-unknown-type-aliases',
  'no-unsafe-dictionary-type',
  'no-widen-then-assert',
  'require-safety-comment-for-type-assertion',
] as const

/** The opt-in Effect rules (disabled by default). */
export const DEFAULT_EFFECT_RULES = [
  'no-service-constructor-imports',
] as const

/** Plugin config surface (declared interface; defaults come from `Config`). */
export interface Config {
  /** Generic anti-slop rules enabled for `anti_slop_lint`. Default: all 15 generic rules. */
  enabledRules?: string[]
  /** Default lint target (a file, directory, or glob) when the tool omits `target`. */
  defaultTarget?: string
  /** Whether the opt-in Effect rules are enabled. Default: false. */
  effectRules?: boolean
  /** Severity applied to findings. Default: 'error'. */
  severity?: AntiSlopSeverity
  /** Path to an oxlint binary; default resolves `oxlint` from PATH. */
  oxlintBinary?: string
  /** Tool execution timeout in milliseconds. Default: 60000. */
  timeoutMs?: number
}

/** Schemastery config with defaults; cordis applies this before `apply(ctx, config)`. */
export const Config: z<Config> = z.object({
  enabledRules: z.array(z.string()).default([...DEFAULT_ENABLED_RULES]),
  defaultTarget: z.string(),
  effectRules: z.boolean().default(false),
  severity: z.union([z.const('error'), z.const('warn'), z.const('off')]).default('error'),
  oxlintBinary: z.string(),
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
})

/**
 * Resolved config after schemastery defaults. `defaultTarget` and
 * `oxlintBinary` are optional at runtime (schemastery drops absent object
 * keys), so the resolved type keeps them optional.
 */
export type ResolvedConfig = Omit<Required<Config>, 'defaultTarget' | 'oxlintBinary'> & {
  defaultTarget?: string
  oxlintBinary?: string
}

/** Resolve the effective enabled rule names from config + per-call flags. */
export function resolveEnabledRules(config: ResolvedConfig, effect: boolean | undefined, requested?: string[]): string[] {
  const requestedSet = requested !== undefined ? new Set(requested) : undefined
  if (requestedSet !== undefined) {
    return [...requestedSet].sort()
  }
  const generic = [...config.enabledRules]
  return effect === true || config.effectRules === true
    ? [...generic, ...DEFAULT_EFFECT_RULES]
    : generic
}

/** Whether a requested rule name is known (generic or effect). */
export function isKnownRule(name: string): boolean {
  return (DEFAULT_ENABLED_RULES as readonly string[]).includes(name)
    || (DEFAULT_EFFECT_RULES as readonly string[]).includes(name)
}
