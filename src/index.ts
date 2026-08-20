/**
 * dsh-anti-slop bundle entry: anti-slop Oxlint rules for DeepSeek Harness.
 *
 * Registers:
 *  - `anti_slop_lint` tool: run the vendored anti-slop Oxlint rules against a
 *    target without touching its configuration (via a generated temp config).
 *  - the `install-anti-slop` skill (bundled, with directory resourceBase).
 *  - the `/anti-slop` command (project status).
 *  - a standing system-prompt section (tool guidance, order 150).
 *
 * @module dsh-anti-slop/src/index
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only imports activate the cordis Context augmentations below (services
// are read via ctx.get at runtime; only the augmentation is needed for types).
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { Config, type ResolvedConfig } from './config.ts'
import { applyTool, TOOL_GUIDANCE, PROMPT_SECTION_ORDER } from './tool.ts'
import { applySkills } from './skills.ts'
import { applyCommand } from './command.ts'

// Re-export the schemastery `Config` so cordis's plugin loader applies the
// declared defaults before `apply` runs (`plugin.Config` is read in
// cordis's registry; without this, the raw user config is passed through and
// `enabledRules`/`effectRules`/`severity`/`timeoutMs` stay `undefined`).
export { Config }

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-anti-slop'

/** Services required by this plugin. */
export const inject = ['tools', 'systemPrompt', 'subprocess', 'skills', 'commands']

/**
 * Apply the bundle: register the tool, the standing prompt section, the skill,
 * and the command. All registrations are effects scoped to this plugin's
 * composition.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = config as ResolvedConfig
  ctx.systemPrompt.section({
    name: 'anti-slop:standing',
    order: PROMPT_SECTION_ORDER,
    text: TOOL_GUIDANCE,
  })
  applyTool(ctx, resolved)
  applySkills(ctx)
  applyCommand(ctx, resolved)
}
