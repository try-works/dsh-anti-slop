/**
 * The `anti_slop_lint` tool: run the vendored anti-slop Oxlint rules against a
 * target without touching the target's configuration.
 *
 * The tool accepts a target (file, directory, or glob), an optional rule
 * subset, an optional opt-in for the Effect rules, and an optional `fix`. It
 * executes through {@link module:dsh-anti-slop/src/lint-engine} and renders a
 * compact findings card.
 *
 * @module dsh-anti-slop/src/tool
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallView } from '@deepseek-ai/dsh-tools'
import type { ResolvedConfig } from './config.ts'
import { DEFAULT_EFFECT_RULES, DEFAULT_ENABLED_RULES, resolveEnabledRules } from './config.ts'
import type { AntiSlopFinding } from './lint-engine.ts'
import { formatFinding, runAntiSlopLint } from './lint-engine.ts'
import { EFFECT_RULES, GENERIC_RULES } from './rules-registry.ts'
import { inspectProject } from './project.ts'

/** Tool name registered on ctx.tools. */
export const TOOL_NAME = 'anti_slop_lint'

/** System-prompt section order (tool-guidance band 100–199). */
export const PROMPT_SECTION_ORDER = 150

/** Rendered card cap: first N findings inline, then a note. */
const MAX_RENDERED_FINDINGS = 50

/** The standing guidance text shown when the tool is available. */
export const TOOL_GUIDANCE = `Use the anti_slop_lint tool — not shell oxlint or the install-anti-slop skill alone — to lint a target against the vendored anti-slop rules without touching the target's configuration. Pass a file, directory, or glob as target; optionally restrict rules or enable the opt-in Effect rules (effect: true). The tool runs oxlint with the anti-slop plugins pre-registered and returns findings with file, line, column, rule, and message. Use it whenever code you write or review may contain low-evidence patterns (unknown returns, chained assertions, module mocking, unsafe dictionaries, and the other vendored rules).`

/** Validated tool input. */
export interface AntiSlopLintInput {
  target: string
  rules?: string[]
  effect?: boolean
  fix?: boolean
  severity?: 'error' | 'warn' | 'off'
}

/** Validate and normalize tool arguments. */
export function parseToolArgs(args: { target?: string; rules?: unknown; effect?: unknown; fix?: unknown; severity?: unknown }, config: ResolvedConfig): AntiSlopLintInput {
  const target = args.target ?? config.defaultTarget
  if (target === undefined || target.trim().length === 0) {
    throw new Error('target is required when the plugin config does not set defaultTarget')
  }
  let rules: string[] | undefined
  if (args.rules !== undefined) {
    if (!Array.isArray(args.rules) || args.rules.length === 0) {
      throw new Error('rules must be a non-empty array of rule names when given')
    }
    for (const rule of args.rules) {
      if (typeof rule !== 'string') throw new Error('rules must contain only strings')
    }
    rules = args.rules as string[]
  }
  if (args.effect !== undefined && typeof args.effect !== 'boolean') throw new Error('effect must be a boolean when given')
  if (args.fix !== undefined && typeof args.fix !== 'boolean') throw new Error('fix must be a boolean when given')
  if (args.severity !== undefined && args.severity !== 'error' && args.severity !== 'warn' && args.severity !== 'off') {
    throw new Error('severity must be one of error, warn, off when given')
  }
  return {
    target,
    ...rules !== undefined ? { rules } : {},
    ...args.effect !== undefined ? { effect: args.effect as boolean } : {},
    ...args.fix !== undefined ? { fix: args.fix as boolean } : {},
    ...args.severity !== undefined ? { severity: args.severity as 'error' | 'warn' | 'off' } : {},
  }
}

/** Format the run result into the tool's content block. */
export function formatRunResult(result: { status: string; message: string; findings?: AntiSlopFinding[] }): string {
  switch (result.status) {
    case 'clean':
      return result.message
    case 'findings': {
      const findings = result.findings ?? []
      const lines = findings.slice(0, MAX_RENDERED_FINDINGS).map(formatFinding)
      const more = findings.length > MAX_RENDERED_FINDINGS
        ? `\n… and ${findings.length - MAX_RENDERED_FINDINGS} more finding(s)`
        : ''
      return `${result.message}\n${lines.join('\n')}${more}`
    }
    case 'oxlint-not-found':
    case 'error':
      return result.message
    default:
      return result.message
  }
}

/**
 * Register the `anti_slop_lint` tool and its system-prompt guidance on `ctx`.
 * The tool reads `ctx.subprocess` for oxlint resolution and execution; the
 * plugin must inject `tools`, `systemPrompt`, and `subprocess`.
 */
export function applyTool(ctx: Context, config: ResolvedConfig): void {
  ctx.systemPrompt.section({
    name: 'tool:anti-slop-lint',
    order: PROMPT_SECTION_ORDER,
    text: TOOL_GUIDANCE,
  })

  const ruleList = `Generic rules: ${GENERIC_RULES.join(', ')}. Effect rules (opt-in): ${EFFECT_RULES.join(', ')}.`

  const tool = defineTool({
    name: TOOL_NAME,
    description: `Run the vendored anti-slop Oxlint rules against a target (file, directory, or glob) without touching the target's configuration. `
      + 'Returns findings with file, line, column, rule, and message. '
      + `Defaults to ${DEFAULT_ENABLED_RULES.length} generic rules at error severity; pass effect: true (or set config effectRules) for the Effect rules. `
      + `fix: true applies oxlint auto-fixes — only safe for a single explicit target. ` + ruleList,
    parameters: {
      target: { type: 'string', required: true, description: 'File, directory, or glob to lint (e.g. "src", "src/index.ts", "src/**/*.ts"). Relative paths resolve against the project root discovered from the nearest .git.' },
      rules: {
        type: 'array',
        description: 'Optional subset of anti-slop rule names to run (defaults to the configured enabled rules).',
        items: { type: 'string' },
      },
      effect: { type: 'boolean', description: 'Also run the opt-in Effect rules (default: false).' },
      fix: { type: 'boolean', description: 'Apply oxlint auto-fixes. Only use with a single explicit target. Default: false.' },
      severity: { type: 'string', description: 'Override severity for this run: error, warn, or off. Default: config severity.' },
    },
    timeoutMs: config.timeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, description: 'clean | findings | oxlint-not-found | error' },
          message: { type: 'string', required: true },
          findings: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                file: { type: 'string', required: true },
                plugin: { type: 'string', required: true },
                rule: { type: 'string', required: true },
                severity: { type: 'string', required: true },
                line: { type: 'integer', required: true },
                column: { type: 'integer', required: true },
                message: { type: 'string', required: true },
              },
            },
          },
          filesScanned: { type: 'integer', required: true },
          rulesRun: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatRunResult(value) }],
    },
    async execute(args, exec) {
      const input = parseToolArgs(args, config)
      const effect = input.effect ?? false
      const rules = resolveEnabledRules(config, effect, input.rules)
      const result = await runAntiSlopLint(ctx, exec, config, {
        target: input.target,
        rules,
        effect,
        fix: input.fix ?? false,
        denyWarnings: input.severity === 'warn' ? false : config.severity === 'error',
      })
      return {
        status: result.status,
        message: result.message,
        findings: result.status === 'clean' || result.status === 'findings' ? result.findings : [],
        filesScanned: result.status === 'clean' || result.status === 'findings' ? result.filesScanned : 0,
        rulesRun: result.status === 'clean' || result.status === 'findings' ? result.rulesRun : 0,
      }
    },
    presentCall: (args): ToolCallView => ({
      card: 'generic',
      title: `anti-slop lint ${(args as { target?: string }).target ?? ''}`.trim(),
      kind: 'execute',
      locations: [(args as { target?: string }).target].filter((path): path is string => path !== undefined).map(path => ({ path })),
    }),
  })

  ctx.tools.register(tool)
}

/** Re-exported for tests and the command. */
export { inspectProject }
