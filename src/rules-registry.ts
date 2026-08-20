/**
 * Rule-name registry for the vendored anti-slop plugins.
 *
 * This module is the single source of truth for which rule names the
 * `anti_slop_lint` tool can enable, and how a rule name maps to the plugin
 * (generic `anti-slop` vs opt-in `anti-slop-effect`).
 *
 * @module dsh-anti-slop/src/rules-registry
 */

/** Plugin namespace for the generic rules. */
export const GENERIC_PLUGIN = 'anti-slop'

/** Plugin namespace for the opt-in Effect rules. */
export const EFFECT_PLUGIN = 'anti-slop-effect'

/** All generic rule names (mirror of upstream `src/index.ts`). */
export const GENERIC_RULES = [
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

/** All opt-in Effect rule names (mirror of upstream `src/effect/index.ts`). */
export const EFFECT_RULES = [
  'no-service-constructor-imports',
] as const

/** A rule name qualified with its plugin namespace, e.g. `anti-slop/no-unknown-returns`. */
export type QualifiedRuleName = `${typeof GENERIC_PLUGIN}/${string}` | `${typeof EFFECT_PLUGIN}/${string}`

/** Whether a rule name is a known generic or Effect rule. */
export function isKnownRule(name: string): boolean {
  return (GENERIC_RULES as readonly string[]).includes(name)
    || (EFFECT_RULES as readonly string[]).includes(name)
}

/** Resolve a rule name to its plugin namespace. */
export function pluginOf(rule: string): typeof GENERIC_PLUGIN | typeof EFFECT_PLUGIN {
  return (EFFECT_RULES as readonly string[]).includes(rule) ? EFFECT_PLUGIN : GENERIC_PLUGIN
}

/** Qualify a rule name with its plugin namespace. */
export function qualify(rule: string): QualifiedRuleName {
  return `${pluginOf(rule)}/${rule}` as QualifiedRuleName
}
