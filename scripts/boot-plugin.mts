// In-process boot smoke of the dsh-anti-slop plugin: verifies the tool, the
// skill, the command, and the prompt section register, and runs one live lint
// against a scratch fixture using the LocalSubprocessRuntime + the repo's oxlint.
//
// Usage: node scripts/boot-plugin.mts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as plugin from '../src/index.ts'

const ctx = new Context()
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(LocalSubprocessRuntime)
await ctx.plugin(CommandRuntime)
await ctx.plugin(SkillRegistry)

const fiber = await ctx.plugin(plugin, {
  enabledRules: undefined,
  defaultTarget: undefined,
  effectRules: false,
  severity: 'error',
  oxlintBinary: undefined,
  timeoutMs: 60_000,
})

const schemas = ctx.tools.schemas().map(s => s.name)
console.log('HAS anti_slop_lint tool:', schemas.includes('anti_slop_lint'))

const skillNames = (await ctx.skills.list()).map(s => s.name)
console.log('HAS install-anti-slop skill:', skillNames.includes('install-anti-slop'))

// The command registry requires an agent handle to list; verify via a
// minimal stand-in that satisfies the descriptor projection.
const commandNames = (ctx.commands as unknown as { list: (agent: unknown) => unknown[] }).list({}).map((c: unknown) => (c as { name: string }).name)
console.log('HAS anti-slop command:', commandNames.includes('anti-slop'))

const assembly = await ctx.systemPrompt.assemble({})
const promptText = assembly.sections.map(s => s.text).join('\n')
console.log('HAS anti-slop prompt section:', promptText.includes('anti_slop_lint'))

// Build a scratch fixture that trips anti-slop/no-unknown-returns.
const scratch = mkdtempSync(join(tmpdir(), 'dsh-anti-slop-boot-'))
try {
  writeFileSync(join(scratch, 'fixture.ts'), 'function load(): unknown { return 1 }\n', 'utf8')
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: 'boot-1',
    name: 'anti_slop_lint',
    arguments: { target: join(scratch, 'fixture.ts'), rules: ['no-unknown-returns'] },
  })
  const text = result.content.map(c => c.type === 'text' ? c.text : '').join('')
  console.log('EXEC isError:', result.isError)
  console.log('EXEC has finding:', text.includes('anti-slop/no-unknown-returns'))
  if (result.isError || !text.includes('anti-slop/no-unknown-returns')) {
    console.error('FAIL: live lint did not produce the expected finding')
    console.error(text)
    process.exit(1)
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

await fiber.dispose()
console.log('DISPOSED OK; tools after dispose:', ctx.tools.schemas().length)
