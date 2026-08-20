/**
 * The bundled install-anti-slop skill registration.
 *
 * The skill body is the upstream anti-slop SKILL.md verbatim plus a short DSH
 * appendix (see skills/install-anti-slop/SKILL.md). The registration uses a
 * directory `resourceBase` pointing at the bundled skill directory so the
 * skill body's relative references (assets/anti-slop/…) resolve against the
 * bundle's copy.
 *
 * @module dsh-anti-slop/src/skills
 */

import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The bundled skill directory (this module lives at src/skills.ts). */
export function skillDirectory(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'skills/install-anti-slop')
}

/** The skill body: SKILL.md verbatim from the bundled skill directory. */
export function skillBody(): string {
  return readFileSync(join(skillDirectory(), 'SKILL.md'), 'utf8')
}

/**
 * Register the install-anti-slop skill. Returns the cordis effect disposer.
 */
export function applySkills(ctx: Context): () => void {
  return ctx.skills.register({
    name: 'install-anti-slop',
    description: 'Install the vendored anti-slop Oxlint rules into a project as a persistent local setup (oxlint config + tools/oxlint/anti-slop). Use for a durable install; use the anti_slop_lint tool for one-off linting without configuration changes.',
    source: 'bundled',
    content: skillBody(),
    resourceBase: { kind: 'directory', path: skillDirectory() },
  })
}
