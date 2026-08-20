/**
 * The anti-slop lint engine: run the vendored anti-slop Oxlint plugins against
 * a target without touching the target's own configuration.
 *
 * ## How it works
 *
 * oxlint is invoked as an external binary through the `ctx.subprocess` seam
 * with a *generated* config file (written to a temp directory, never the
 * target project) that:
 *
 *  - registers the vendored plugins via `jsPlugins` with absolute specifiers
 *    pointing into this bundle's `skills/install-anti-slop/assets/anti-slop`;
 *  - enables only the selected anti-slop rules at the configured severity;
 *  - runs with `-A all` (suppress every built-in category so only our rules
 *    fire), `--disable-nested-config` and `--no-ignore` (deterministic,
 *    target-config-independent), and `--format json`.
 *
 * The vendored plugin imports `@oxlint/plugins`, which Node resolves by
 * walking up from the plugin file — reaching this bundle's own `node_modules`
 * when installed (and the repo's `node_modules` in development), so no
 * dependency shim needs to be materialized. The target project is never
 * mutated: no config file is written there, and `fix` only applies when the
 * caller explicitly requests it with a single target.
 *
 * @module dsh-anti-slop/src/lint-engine
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ResolvedConfig } from './config.ts'
import { EFFECT_PLUGIN, GENERIC_PLUGIN, isKnownRule, qualify } from './rules-registry.ts'
import { findProjectRoot } from './project.ts'

/** Stdout cap for one oxlint JSON run (diagnostics text; a large repo run stays far below this). */
export const LINT_STDOUT_MAX_BYTES = 4 * 1024 * 1024

/** Stderr cap: oxlint's launch/diagnostic tail. */
export const LINT_STDERR_MAX_BYTES = 64 * 1024

/** Terminate-escalation grace for the seam. */
export const LINT_GRACE_MS = 5_000

/** Absolute path to the vendored generic plugin entry (this bundle's skill assets). */
export function vendoredPluginPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'skills/install-anti-slop/assets/anti-slop/index.ts')
}

/** Absolute path to the vendored opt-in Effect plugin entry. */
export function vendoredEffectPluginPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'skills/install-anti-slop/assets/anti-slop/effect/index.ts')
}

/** One raw oxlint JSON diagnostic. */
export interface RawOxlintDiagnostic {
  message: string
  code: string
  severity: string
  filename: string
  labels?: { span: { offset: number; length: number; line: number; column: number } }[]
}

/** Raw oxlint `--format json` output shape. */
export interface RawOxlintOutput {
  diagnostics: RawOxlintDiagnostic[]
  number_of_files: number
  number_of_rules: number
}

/** A normalized anti-slop finding. */
export interface AntiSlopFinding {
  /** Path as displayed: cwd-relative when possible, else as oxlint reported it. */
  file: string
  /** Plugin namespace: `anti-slop` or `anti-slop-effect`. */
  plugin: string
  /** Rule name without plugin prefix. */
  rule: string
  /** Normalized severity: `error` | `warning`. */
  severity: string
  /** 1-based line. */
  line: number
  /** 1-based column. */
  column: number
  message: string
}

/** Outcome of one lint run (soft failures are `status: 'error'`, not throws). */
export type AntiSlopRunResult =
  | { status: 'clean'; findings: AntiSlopFinding[]; filesScanned: number; rulesRun: number; message: string }
  | { status: 'findings'; findings: AntiSlopFinding[]; filesScanned: number; rulesRun: number; message: string }
  | { status: 'oxlint-not-found'; message: string }
  | { status: 'error'; message: string }

/**
 * Build the oxlint config JSON document enabling the given rules on the
 * vendored plugins. Exported for tests.
 */
export function buildOxlintConfigJson(rules: string[], severity: 'error' | 'warn' | 'off'): string {
  const ruleEntries: Record<string, string> = {}
  for (const rule of rules) ruleEntries[qualify(rule)] = severity
  const config = {
    jsPlugins: [
      { name: GENERIC_PLUGIN, specifier: vendoredPluginPath() },
      { name: EFFECT_PLUGIN, specifier: vendoredEffectPluginPath() },
    ],
    rules: ruleEntries,
  }
  return JSON.stringify(config, null, 2)
}

/** Options for argv construction (exported for tests). */
export interface OxlintArgvOptions {
  configPath: string
  target: string
  fix: boolean
  denyWarnings: boolean
}

/** How to launch oxlint: a program plus fixed prefix argv (e.g. node + JS entry). */
export interface OxlintLaunch {
  /** The executable to spawn (argv[0]). */
  readonly program: string
  /** Fixed argv immediately after the program (a JS entry for `node`, else empty). */
  readonly prefix: readonly string[]
}

/**
 * On Windows, `ctx.subprocess.resolveExecutable('oxlint')` returns the
 * `.cmd` shim path, which cannot be spawned directly (the seam spawns without
 * a shell → EINVAL). Parse the shim to find the real JS entry and launch it
 * via the current Node executable. Returns the plain program when the path is
 * not a Windows shim.
 */
export function launchFromExecutable(executable: string): OxlintLaunch {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) {
    const entry = shimJsEntry(executable)
    if (entry !== undefined) {
      return { program: process.execPath, prefix: [entry] }
    }
  }
  return { program: executable, prefix: [] }
}

/** Parse a Windows `.cmd`/`.bat` shim for the JS entry it invokes. */
export function shimJsEntry(shimPath: string): string | undefined {
  try {
    const text = readFileSync(shimPath, 'utf8')
    // Match the quoted "%~dp0\relative\script" argument(s) — the last one is
    // the script; earlier ones are the node.exe path.
    const matches = [...text.matchAll(/"%~dp0\\([^"]+)"/g)]
    if (matches.length === 0) return undefined
    const rel = matches[matches.length - 1][1]
    const target = join(dirname(shimPath), rel)
    return existsSync(target) ? target : undefined
  } catch {
    return undefined
  }
}

/**
 * Build the complete oxlint argv for one run. `-A all` suppresses every
 * built-in category; `--disable-nested-config` + `--no-ignore` make the run
 * independent of the target's own config/ignore files.
 */
export function buildOxlintArgv(launch: OxlintLaunch, opts: OxlintArgvOptions): string[] {
  const argv = [
    launch.program,
    ...launch.prefix,
    '--config', opts.configPath,
    '--allow', 'all',
    '--disable-nested-config',
    '--no-ignore',
    '--format', 'json',
  ]
  if (opts.denyWarnings) argv.push('--deny-warnings')
  if (opts.fix) argv.push('--fix')
  argv.push(opts.target)
  return argv
}

/** Parse the plugin-qualified code `anti-slop(no-unknown-returns)` into plugin + rule. */
export function parseDiagnosticCode(code: string): { plugin: string; rule: string } {
  const match = /^([^()]+)\(([^()]+)\)$/.exec(code)
  if (match === null) return { plugin: '', rule: code }
  return { plugin: match[1], rule: match[2] }
}

/** Parse oxlint `--format json` stdout into raw diagnostics. Throws on malformed output. */
export function parseOxlintDiagnostics(stdout: string): RawOxlintOutput {
  const start = stdout.indexOf('{')
  if (start === -1) throw new Error('oxlint produced no JSON output')
  const text = stdout.slice(start)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error: unknown) {
    throw new Error(`oxlint produced malformed JSON output (${error instanceof Error ? error.message : String(error)})`)
  }
  const output = parsed as Partial<RawOxlintOutput>
  if (!Array.isArray(output.diagnostics)) {
    throw new Error('oxlint JSON output is missing the diagnostics array')
  }
  return {
    diagnostics: output.diagnostics as RawOxlintDiagnostic[],
    number_of_files: typeof output.number_of_files === 'number' ? output.number_of_files : 0,
    number_of_rules: typeof output.number_of_rules === 'number' ? output.number_of_rules : 0,
  }
}

/** Normalize a raw diagnostic into a finding with display-relative path (forward slashes). */
export function normalizeFinding(diagnostic: RawOxlintDiagnostic, workdir: string): AntiSlopFinding {
  const { plugin, rule } = parseDiagnosticCode(diagnostic.code)
  const label = diagnostic.labels?.[0]?.span
  const file = isAbsolute(diagnostic.filename)
    ? (() => {
      const rel = relative(workdir, diagnostic.filename)
      return (rel === '' ? '.' : (rel === '..' || rel.startsWith(`..${sep}`) ? diagnostic.filename : rel)).split(sep).join('/')
    })()
    : diagnostic.filename
  return {
    file,
    plugin,
    rule,
    severity: diagnostic.severity === 'warning' ? 'warning' : 'error',
    line: label?.line ?? 0,
    column: label?.column ?? 0,
    message: diagnostic.message,
  }
}

/** Format a finding as a compact single line (used in the rendered card). */
export function formatFinding(finding: AntiSlopFinding): string {
  return `${finding.file}:${finding.line}:${finding.column} [${finding.plugin}/${finding.rule}] ${finding.message}`
}

/**
 * Resolve the oxlint binary: a configured absolute path is used directly
 * (must exist); otherwise the executable is resolved through the subprocess
 * seam's PATH. Returns `undefined` when oxlint is not installed.
 */
export async function resolveOxlintBinary(ctx: Context, config: ResolvedConfig, signal?: AbortSignal): Promise<string | undefined> {
  const configured = config.oxlintBinary
  if (configured !== undefined && configured.length > 0) {
    if (!isAbsolute(configured)) throw new Error('config oxlintBinary must be an absolute path')
    if (!existsSync(configured)) return undefined
    return configured
  }
  try {
    return await ctx.subprocess.resolveExecutable('oxlint', undefined, signal)
  } catch {
    return undefined
  }
}

/** Options for one engine run (derived from tool args + resolved config). */
export interface AntiSlopLintOptions {
  target: string
  rules: string[]
  effect: boolean
  fix: boolean
  denyWarnings: boolean
}

/**
 * Run the vendored anti-slop rules over `target` via oxlint. Never writes to
 * the target project: the generated config lives in a temp directory that is
 * removed before returning.
 */
export async function runAntiSlopLint(
  ctx: Context,
  exec: ToolRunContext,
  config: ResolvedConfig,
  opts: AntiSlopLintOptions,
): Promise<AntiSlopRunResult> {
  if (exec.signal.aborted) {
    return { status: 'error', message: 'anti_slop_lint was aborted before it could start (tool timeout or caller cancellation)' }
  }
  const binary = await resolveOxlintBinary(ctx, config, exec.signal)
  if (binary === undefined) {
    return {
      status: 'oxlint-not-found',
      message: 'oxlint is not installed in this environment. Install it in the target project (e.g. `npm i -D oxlint`) '
        + 'or use the install-anti-slop skill, or set the oxlintBinary config option to an absolute oxlint path.',
    }
  }

  // Validate requested rules before doing any work.
  for (const rule of opts.rules) {
    if (!isKnownRule(rule)) {
      return { status: 'error', message: `unknown anti-slop rule: ${rule}` }
    }
  }

  const projectRoot = findProjectRoot(opts.target)
  const configDir = mkdtempSync(join(tmpdir(), 'anti-slop-config-'))
  const configPath = join(configDir, 'oxlint.config.json')
  let handle: SubprocessHandle
  try {
    writeFileSync(configPath, buildOxlintConfigJson(opts.rules, config.severity), 'utf8')
    const launch = launchFromExecutable(binary)
    const argv = buildOxlintArgv(launch, {
      configPath,
      target: opts.target,
      fix: opts.fix,
      denyWarnings: opts.denyWarnings,
    })
    handle = ctx.subprocess.spawn({
      argv,
      cwd: projectRoot,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: LINT_STDOUT_MAX_BYTES },
        stderr: { maxBytes: LINT_STDERR_MAX_BYTES },
      },
      graceMs: LINT_GRACE_MS,
      signal: exec.signal,
    } satisfies SubprocessSpawnSpec)
  } catch (error: unknown) {
    try { rmSync(configDir, { recursive: true, force: true }) } catch { /* best-effort */ }
    if (exec.signal.aborted) {
      return { status: 'error', message: 'anti_slop_lint was aborted before completion (tool timeout or caller cancellation)' }
    }
    return { status: 'error', message: `anti_slop_lint could not start oxlint: ${error instanceof Error ? error.message : String(error)}` }
  }

  let outcome: SubprocessOutcome
  try {
    outcome = await handle.done
  } catch (error: unknown) {
    try { rmSync(configDir, { recursive: true, force: true }) } catch { /* best-effort */ }
    return { status: 'error', message: `anti_slop_lint could not start oxlint: ${error instanceof Error ? error.message : String(error)}` }
  }

  const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
  const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
  try { rmSync(configDir, { recursive: true, force: true }) } catch { /* best-effort */ }

  if (exec.signal.aborted) {
    return { status: 'error', message: 'anti_slop_lint was aborted before completion (tool timeout or caller cancellation)' }
  }
  if (outcome.signal !== null || outcome.exitCode === null) {
    return { status: 'error', message: `anti_slop_lint was killed by signal ${outcome.signal ?? '(unknown)'}` }
  }
  if (outcome.exitCode !== 0 && outcome.exitCode !== 1) {
    const tail = stderr.trim().split('\n').slice(-8).join('\n')
    return { status: 'error', message: `oxlint exited with code ${outcome.exitCode}${tail.length > 0 ? `:\n${tail}` : ''}` }
  }

  let parsed: RawOxlintOutput
  try {
    parsed = parseOxlintDiagnostics(stdout)
  } catch (error: unknown) {
    return { status: 'error', message: `anti_slop_lint could not parse oxlint output: ${error instanceof Error ? error.message : String(error)}` }
  }
  const findings = parsed.diagnostics.map(diagnostic => normalizeFinding(diagnostic, projectRoot))
  if (findings.length > 0) {
    return {
      status: 'findings',
      findings,
      filesScanned: parsed.number_of_files,
      rulesRun: parsed.number_of_rules,
      message: `${findings.length} anti-slop finding(s) across ${parsed.number_of_files} file(s) (${parsed.number_of_rules} rule(s) run).`,
    }
  }
  return {
    status: 'clean',
    findings,
    filesScanned: parsed.number_of_files,
    rulesRun: parsed.number_of_rules,
    message: `No anti-slop findings in ${parsed.number_of_files} file(s) (${parsed.number_of_rules} rule(s) run).`,
  }
}
