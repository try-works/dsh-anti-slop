/**
 * The `/anti-slop` command: report the target project's anti-slop setup status
 * and how to use the tool/skill.
 *
 * @module dsh-anti-slop/src/command
 */

import type { Context } from '@deepseek-ai/cordis'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ResolvedConfig } from './config.ts'
import { DEFAULT_EFFECT_RULES, DEFAULT_ENABLED_RULES } from './config.ts'
import { inspectProject } from './project.ts'

/** Where the skill installs the vendored plugin inside a target project. */
const INSTALL_RELATIVE = join('tools', 'oxlint', 'anti-slop')

/**
 * Register the `/anti-slop` command. Reports oxlint presence, the target
 * project's anti-slop install state (config registration + vendored copy),
 * the enabled rules, and pointers to the tool and skill.
 */
export function applyCommand(ctx: Context, config: ResolvedConfig): () => void {
  return ctx.commands.register({
    name: 'anti-slop',
    description: 'Show anti-slop status for a project and how to use the anti_slop_lint tool and install-anti-slop skill.',
    handler: async () => {
      const target = config.defaultTarget ?? process.cwd()
      const info = inspectProject(target)
      const lines: string[] = [
        `anti-slop status for ${target}`,
        `  project root: ${info.root}`,
        `  oxlint config: ${info.hasOxlintConfig ? 'present' : 'none found'}`,
        `  anti-slop registered in oxlint config: ${info.hasAntiSlopRegistration ? 'yes' : 'no'}`,
        `  vendored copy at ${join(info.root, INSTALL_RELATIVE)}: ${existsSync(join(info.root, INSTALL_RELATIVE)) ? 'present' : 'absent'}`,
        `  enabled rules: ${config.enabledRules.join(', ')}${config.effectRules ? `, ${DEFAULT_EFFECT_RULES.join(', ')} (effect)` : ''}`,
        '',
        'Use the anti_slop_lint tool for one-off linting (no config changes).',
        'Use the install-anti-slop skill for a persistent local install.',
      ]
      return { kind: 'success', text: lines.join('\n') }
    },
  })
}
