import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as plugin from '../src/index.ts'
import { materializeVendoredPlugin, buildOxlintConfigJson } from '../src/lint-engine.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Resolve the repo's oxlint `.cmd` shim (plain-node launch path) if present. */
function resolveOxlintShim(): string | undefined {
  const candidates = [
    join(repoRoot, 'node_modules', '.bin', 'oxlint.cmd'),
    join(repoRoot, 'node_modules', '.bin', 'oxlint'),
  ]
  return candidates.find(existsSync)
}

describe('vendored plugin materialization (plain-node path)', () => {
  it('copies the plugin tree outside node_modules and links @oxlint/plugins resolvably', () => {
    const materialized = materializeVendoredPlugin()
    try {
      // The whole point of the fix: the plugin sources must NOT live under
      // node_modules, where Node 24 refuses native type-stripping.
      expect(materialized.dir.split(sep)).not.toContain('node_modules')
      expect(materialized.genericPath.split(sep)).not.toContain('node_modules')
      expect(materialized.effectPath.split(sep)).not.toContain('node_modules')

      // Both plugin entries were copied into the temp tree.
      expect(existsSync(materialized.genericPath)).toBe(true)
      expect(existsSync(materialized.effectPath)).toBe(true)

      // The generated config points at the temp copies, not the in-bundle tree.
      const json = buildOxlintConfigJson(['no-unknown-returns'], 'error', {
        generic: materialized.genericPath,
        effect: materialized.effectPath,
      })
      const config = JSON.parse(json) as { jsPlugins: { name: string; specifier: string }[] }
      expect(config.jsPlugins[0].specifier).toBe(materialized.genericPath)
      expect(config.jsPlugins[1].specifier).toBe(materialized.effectPath)

      // @oxlint/plugins must resolve from inside the temp tree via the link.
      const requireFromTemp = createRequire(pathToFileURL(materialized.genericPath).href)
      expect(() => requireFromTemp.resolve('@oxlint/plugins')).not.toThrow()
    } finally {
      materialized.dispose()
    }
  })
})

describe('anti_slop_lint live lint via plain Node (regression)', () => {
  it('runs the real oxlint binary with plain node and reports anti-slop/no-unknown-returns', async () => {
    // Boot the plugin into an in-process DSH Context, exactly like
    // scripts/boot-plugin.mts, but the oxlint SUBPROCESS is launched with
    // plain process.execPath (no tsx loader) via launchFromExecutable.
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
      oxlintBinary: resolveOxlintShim(),
      timeoutMs: 60_000,
    })
    try {
      const scratch = mkdtempSync(join(tmpdir(), 'dsh-anti-slop-regression-'))
      try {
        // A fixture that trips anti-slop/no-unknown-returns.
        writeFileSync(join(scratch, 'fixture.ts'), 'function load(): unknown { return 1 }\n', 'utf8')
        const result = await ctx.tools.execute({
          signal: new AbortController().signal,
          callId: CallId('regression-1'),
          name: 'anti_slop_lint',
          arguments: { target: join(scratch, 'fixture.ts'), rules: ['no-unknown-returns'] },
        })
        const text = result.content.map(c => c.type === 'text' ? c.text : '').join('')
        expect(result.isError, text).toBe(false)
        expect(text).toContain('anti-slop/no-unknown-returns')
      } finally {
        rmSync(scratch, { recursive: true, force: true })
      }
    } finally {
      await fiber.dispose()
    }
  }, 60_000)
})

describe('vendored parity guard', () => {
  it('still contains the upstream no-unknown-returns rule (byte-parity sanity)', () => {
    const ruleFile = join(repoRoot, 'skills', 'install-anti-slop', 'assets', 'anti-slop', 'rules', 'no-unknown-returns.ts')
    const text = readFileSync(ruleFile, 'utf8')
    expect(text).toContain('unknownReturn')
  })
})
