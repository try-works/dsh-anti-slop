#!/usr/bin/env node
/**
 * verify.mjs — end-to-end verification for the dsh-anti-slop bundle.
 *
 * Runs, in order, with stdio inherited (no named-pipe capture, so this works
 * under the sandbox):
 *   1. `pnpm run typecheck`          — TypeScript typecheck
 *   2. `pnpm run test:unit`          — vitest unit tests
 *   3. `node scripts/sync-vendored.mjs --check` — vendored parity (manifest +
 *      upstream clone byte-parity)
 *   4. `node --import tsx scripts/boot-plugin.mts` — live smoke: load the
 *      plugin into an in-process DSH Context, register tool/skill/command/
 *      prompt section, and run a real `anti_slop_lint` against a scratch
 *      fixture that must produce a known finding.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Repo root (this module lives at scripts/verify.mjs).
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const node = process.execPath

// `pnpm` is a .cmd shim on Windows and needs a shell; `node` does not, and
// quoting process.execPath under a shell is fragile (Program Files spaces).
// pnpm steps pass a single command string (shell parses it), node steps pass
// cmd + args arrays (shell:false) to avoid the args-concatenation warning.
const steps = [
  { label: 'typecheck', command: 'pnpm run typecheck', shell: true },
  { label: 'unit tests', command: 'pnpm run test:unit', shell: true },
  { label: 'vendored parity', cmd: node, args: ['scripts/sync-vendored.mjs', '--check'], shell: false },
  { label: 'boot smoke (live lint)', cmd: node, args: ['--import', 'tsx', 'scripts/boot-plugin.mts'], shell: false },
]

let failed = 0
for (const step of steps) {
  const { label, shell } = step
  console.log(`\n=== ${label} ===`)
  const result = 'command' in step
    ? spawnSync(step.command, { cwd: root, stdio: 'inherit', shell })
    : spawnSync(step.cmd, step.args, { cwd: root, stdio: 'inherit', shell })
  if (result.error) {
    console.error(`FAIL  ${label}: ${result.error.message}`)
    failed += 1
  } else if (result.status !== 0) {
    console.error(`FAIL  ${label}: exited with code ${result.status}`)
    failed += 1
  } else {
    console.log(`PASS  ${label}`)
  }
}

if (failed > 0) {
  console.error(`\nverify failed: ${failed} step(s) did not pass`)
  process.exit(1)
}
console.log('\nverify: all steps passed')
