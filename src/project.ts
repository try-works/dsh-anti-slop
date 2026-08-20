/**
 * Target-project discovery: nearest project root, oxlint config detection, and
 * whether anti-slop is already registered in the target's lint configuration.
 *
 * The lint tool resolves the project root from the nearest `.git` (or the
 * target's own directory when it is a file) and uses it to (a) pick the
 * working directory for oxlint and (b) detect an existing anti-slop setup for
 * the tool's status output. This module never mutates the target.
 *
 * @module dsh-anti-slop/src/project
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** A target project discovery result. */
export interface ProjectInfo {
  /** Absolute path to the discovered project root. */
  readonly root: string
  /** Whether an oxlint config file was found in the project root. */
  readonly hasOxlintConfig: boolean
  /** Whether an existing anti-slop registration was detected in the oxlint config. */
  readonly hasAntiSlopRegistration: boolean
}

/** Oxlint config file names oxlint auto-discovers. */
const OXLINT_CONFIG_NAMES = [
  'oxlint.config.ts',
  'oxlint.config.js',
  'oxlint.config.mjs',
  'oxlint.config.cjs',
  'oxlint.config.json',
  'oxlint.config.jsonc',
  '.oxlintrc.json',
  '.oxlintrc.jsonc',
  '.oxlintrc',
]

/** Heuristics for an existing anti-slop registration inside an oxlint config. */
const ANTI_SLOP_MARKERS = [
  'anti-slop',
  'antiSlop',
]

/**
 * Walk up from `start` to find the nearest ancestor directory containing a
 * `.git` entry. Falls back to `start` itself.
 */
export function findProjectRoot(start: string): string {
  let current = resolve(start)
  // A file target resolves to its containing directory.
  if (!isDir(current)) current = dirname(current)
  for (;;) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return current
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Inspect a target path (file or directory) and report project facts.
 * Reading config files is best-effort: any parse failure is treated as
 * "no anti-slop registration" (never throws into the tool).
 */
export function inspectProject(target: string): ProjectInfo {
  const root = findProjectRoot(target)
  const configFile = findOxlintConfig(root)
  const hasOxlintConfig = configFile !== undefined
  let hasAntiSlopRegistration = false
  if (configFile !== undefined) {
    try {
      const text = readFileSync(configFile, 'utf8')
      hasAntiSlopRegistration = ANTI_SLOP_MARKERS.some(marker => text.includes(marker))
    } catch {
      // Best-effort; leave false.
    }
  }
  return { root, hasOxlintConfig, hasAntiSlopRegistration }
}

function findOxlintConfig(root: string): string | undefined {
  for (const name of OXLINT_CONFIG_NAMES) {
    const candidate = join(root, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}
