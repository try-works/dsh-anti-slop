import { describe, expect, it } from 'vitest'
import { checkParity, UPSTREAM_REVISION, vendoredFiles, readManifest } from '../src/parity.ts'
import { inspectProject, findProjectRoot } from '../src/project.ts'
import { DEFAULT_ENABLED_RULES } from '../src/config.ts'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('vendored parity', () => {
  it('is byte-identical to the recorded upstream revision (manifest + clone when present)', () => {
    const result = checkParity()
    expect(result.failures, result.failures.join('\n')).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('manifest records the expected upstream revision', () => {
    const manifest = readManifest()
    expect(manifest?.upstreamRevision).toBe(UPSTREAM_REVISION)
  })

  it('vendored file set includes the plugin entries and the skill files', () => {
    const files = vendoredFiles()
    expect(files).toContain('assets/anti-slop/index.ts')
    expect(files).toContain('assets/anti-slop/effect/index.ts')
    expect(files).toContain('SKILL.md')
    expect(files).toContain('scripts/install.mjs')
  })
})

describe('project discovery', () => {
  it('finds the nearest .git ancestor as the project root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'proj-root-'))
    try {
      mkdirSync(join(dir, 'a', 'b'), { recursive: true })
      mkdirSync(join(dir, '.git'))
      expect(findProjectRoot(join(dir, 'a', 'b'))).toBe(dir)
      expect(findProjectRoot(join(dir, 'a', 'b', 'file.ts'))).toBe(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('detects oxlint config and anti-slop registration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'proj-config-'))
    try {
      mkdirSync(join(dir, '.git'))
      writeFileSync(join(dir, 'oxlint.config.mjs'), 'export default { jsPlugins: [{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" }] }\n', 'utf8')
      const info = inspectProject(dir)
      expect(info.root).toBe(dir)
      expect(info.hasOxlintConfig).toBe(true)
      expect(info.hasAntiSlopRegistration).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports no oxlint config when absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'proj-noconfig-'))
    try {
      mkdirSync(join(dir, '.git'))
      const info = inspectProject(dir)
      expect(info.hasOxlintConfig).toBe(false)
      expect(info.hasAntiSlopRegistration).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('plugin Config export (defaults application)', () => {
  it('re-exports the schemastery Config so cordis applies defaults before apply()', async () => {
    // The bundle entry must expose `Config` as a named export; cordis's plugin
    // registry reads `plugin.Config` to validate/apply defaults. Without it,
    // `config.enabledRules` stays undefined and the /anti-slop command throws.
    const entry = await import('../src/index.ts')
    expect(entry.Config).toBeDefined()

    // Apply the Config schema to an empty config and confirm defaults land,
    // mirroring cordis's resolveConfig (result.value on validation success).
    const schema = (entry.Config as { '~standard': { validate: (input: unknown) => { issues?: unknown; value?: unknown } } })['~standard']
    const result = schema.validate({})
    expect(result.issues).toBeUndefined()
    const resolved = (result.value ?? {}) as { enabledRules?: string[]; effectRules?: boolean; severity?: string; timeoutMs?: number }
    expect(resolved.enabledRules).toEqual([...DEFAULT_ENABLED_RULES])
    expect(resolved.effectRules).toBe(false)
    expect(resolved.severity).toBe('error')
    expect(resolved.timeoutMs).toBe(60_000)
  })
})
