import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseDiagnosticCode, parseOxlintDiagnostics, normalizeFinding, buildOxlintArgv, buildOxlintConfigJson, launchFromExecutable, shimJsEntry } from '../src/lint-engine.ts'
import { qualify, pluginOf, isKnownRule, GENERIC_RULES, EFFECT_RULES } from '../src/rules-registry.ts'
import { resolveEnabledRules, DEFAULT_ENABLED_RULES, DEFAULT_EFFECT_RULES } from '../src/config.ts'

describe('rules-registry', () => {
  it('lists all 15 generic rules and the opt-in Effect rule', () => {
    expect(GENERIC_RULES).toHaveLength(15)
    expect(EFFECT_RULES).toContain('no-service-constructor-imports')
  })

  it('qualifies a generic rule with the anti-slop plugin namespace', () => {
    expect(qualify('no-unknown-returns')).toBe('anti-slop/no-unknown-returns')
    expect(qualify('no-service-constructor-imports')).toBe('anti-slop-effect/no-service-constructor-imports')
  })

  it('maps plugin namespace by rule', () => {
    expect(pluginOf('no-unknown-returns')).toBe('anti-slop')
    expect(pluginOf('no-service-constructor-imports')).toBe('anti-slop-effect')
  })

  it('recognizes known rules and rejects unknown ones', () => {
    expect(isKnownRule('no-unknown-returns')).toBe(true)
    expect(isKnownRule('no-service-constructor-imports')).toBe(true)
    expect(isKnownRule('no-such-rule')).toBe(false)
  })
})

describe('config rule resolution', () => {
  it('resolves the default rule set when no call flags are given', () => {
    const rules = resolveEnabledRules(
      { enabledRules: [...DEFAULT_ENABLED_RULES], effectRules: false, severity: 'error', timeoutMs: 60000 },
      undefined,
    )
    expect(rules).toEqual([...DEFAULT_ENABLED_RULES])
  })

  it('adds Effect rules when the call opts in', () => {
    const rules = resolveEnabledRules(
      { enabledRules: [...DEFAULT_ENABLED_RULES], effectRules: false, severity: 'error', timeoutMs: 60000 },
      true,
    )
    expect(rules).toEqual([...DEFAULT_ENABLED_RULES, ...DEFAULT_EFFECT_RULES])
  })

  it('honors an explicit requested subset sorted', () => {
    const rules = resolveEnabledRules(
      { enabledRules: [...DEFAULT_ENABLED_RULES], effectRules: true, severity: 'error', timeoutMs: 60000 },
      false,
      ['no-unknown-returns', 'no-unknown-parameters'],
    )
    expect(rules).toEqual(['no-unknown-parameters', 'no-unknown-returns'])
  })
})

describe('lint-engine argv/config', () => {
  it('builds a config JSON with both plugins and the requested rules at the severity', () => {
    const json = buildOxlintConfigJson(['no-unknown-returns'], 'error')
    const config = JSON.parse(json) as { jsPlugins: { name: string; specifier: string }[]; rules: Record<string, string> }
    expect(config.jsPlugins.map(p => p.name)).toEqual(['anti-slop', 'anti-slop-effect'])
    expect(config.jsPlugins[0].specifier.replace(/\\/g, '/')).toContain('assets/anti-slop/index.ts')
    expect(config.jsPlugins[1].specifier.replace(/\\/g, '/')).toContain('assets/anti-slop/effect/index.ts')
    expect(config.rules).toEqual({ 'anti-slop/no-unknown-returns': 'error' })
  })

  it('builds argv with -A all, no nested config, no ignore, and JSON format', () => {
    const argv = buildOxlintArgv({ program: 'node', prefix: ['C:/oxlint/bin/oxlint'] }, {
      configPath: 'C:/tmp/oxlint.config.json',
      target: 'C:/proj/src',
      fix: false,
      denyWarnings: true,
    })
    expect(argv).toEqual([
      'node', 'C:/oxlint/bin/oxlint',
      '--config', 'C:/tmp/oxlint.config.json',
      '--allow', 'all',
      '--disable-nested-config',
      '--no-ignore',
      '--format', 'json',
      '--deny-warnings',
      'C:/proj/src',
    ])
  })

  it('adds --fix only when requested', () => {
    const argv = buildOxlintArgv({ program: 'oxlint', prefix: [] }, {
      configPath: 'c', target: 't', fix: true, denyWarnings: false,
    })
    expect(argv).toContain('--fix')
    const noFix = buildOxlintArgv({ program: 'oxlint', prefix: [] }, {
      configPath: 'c', target: 't', fix: false, denyWarnings: false,
    })
    expect(noFix).not.toContain('--fix')
  })

  it('parses a Windows .cmd shim into a node + JS entry launch', () => {
    // Simulate the npm .cmd shim shape with a temp file.
    const dir = mkdtempSync(join(tmpdir(), 'oxlint-shim-'))
    try {
      mkdirSync(join(dir, 'bin'))
      writeFileSync(join(dir, 'bin', 'oxlint'), '#!/usr/bin/env node\n', 'utf8')
      const shim = join(dir, 'oxlint.cmd')
      writeFileSync(shim, `@"%~dp0\\node.exe" "%~dp0\\bin\\oxlint" %*\n`, 'utf8')
      const entry = shimJsEntry(shim)
      expect(entry).toBe(join(dir, 'bin', 'oxlint'))
      const launch = launchFromExecutable(shim)
      expect(launch.program).toBe(process.execPath)
      expect(launch.prefix).toEqual([entry])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves a non-shim executable as the plain program', () => {
    const launch = launchFromExecutable('/usr/local/bin/oxlint')
    expect(launch.program).toBe('/usr/local/bin/oxlint')
    expect(launch.prefix).toEqual([])
  })
})

describe('lint-engine output parsing', () => {
  it('parses plugin-qualified diagnostic codes', () => {
    expect(parseDiagnosticCode('anti-slop(no-unknown-returns)')).toEqual({ plugin: 'anti-slop', rule: 'no-unknown-returns' })
    expect(parseDiagnosticCode('anti-slop-effect(no-service-constructor-imports)')).toEqual({ plugin: 'anti-slop-effect', rule: 'no-service-constructor-imports' })
  })

  it('parses oxlint --format json stdout', () => {
    const stdout = JSON.stringify({
      diagnostics: [{
        message: 'This function exposes `unknown` to its caller.',
        code: 'anti-slop(no-unknown-returns)',
        severity: 'error',
        filename: 'D:/proj/src/a.ts',
        labels: [{ span: { offset: 17, length: 7, line: 1, column: 18 } }],
      }],
      number_of_files: 1,
      number_of_rules: 1,
    })
    const output = parseOxlintDiagnostics(stdout)
    expect(output.diagnostics).toHaveLength(1)
    expect(output.number_of_files).toBe(1)
    expect(output.number_of_rules).toBe(1)
  })

  it('throws on non-JSON stdout', () => {
    expect(() => parseOxlintDiagnostics('oxlint: something went wrong')).toThrow(/no JSON output/)
  })

  it('throws on JSON without a diagnostics array', () => {
    expect(() => parseOxlintDiagnostics('{"nope":true}')).toThrow(/missing the diagnostics array/)
  })

  it('normalizes a diagnostic into a finding with a workdir-relative path', () => {
    const finding = normalizeFinding({
      message: 'msg',
      code: 'anti-slop(no-unknown-returns)',
      severity: 'error',
      filename: 'D:/proj/src/a.ts',
      labels: [{ span: { offset: 0, length: 1, line: 3, column: 5 } }],
    }, 'D:/proj')
    expect(finding).toMatchObject({
      file: 'src/a.ts',
      plugin: 'anti-slop',
      rule: 'no-unknown-returns',
      severity: 'error',
      line: 3,
      column: 5,
      message: 'msg',
    })
  })

  it('normalizes warning severity', () => {
    const finding = normalizeFinding({
      message: 'w', code: 'anti-slop(no-reflect-get)', severity: 'warning',
      filename: 'a.ts', labels: [{ span: { offset: 0, length: 1, line: 1, column: 1 } }],
    }, 'D:/proj')
    expect(finding.severity).toBe('warning')
  })
})
