#!/usr/bin/env node
/**
 * Sync or verify the vendored anti-slop rule sources and skill files.
 *
 * The vendored copies live under skills/install-anti-slop/assets/anti-slop
 * and are byte-identical to the upstream anti-slop repository
 * (https://github.com/dmmulroy/anti-slop) at the recorded revision. This
 * script re-copies from the gitignored anti-slop-upstream clone when it is
 * present, and always (re)writes the hash manifest scripts/vendored-manifest.json.
 *
 * Modes:
 *   node scripts/sync-vendored.mjs          copy + regenerate manifest
 *   node scripts/sync-vendored.mjs --check  verify vendored files match the
 *                                           manifest (and the clone when present)
 */
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const upstreamRoot = join(root, 'anti-slop-upstream')
const upstreamSrc = join(upstreamRoot, 'src')
const destination = join(root, 'skills/install-anti-slop/assets/anti-slop')
const manifestPath = join(root, 'scripts/vendored-manifest.json')
const check = process.argv.includes('--check')

/** Expected upstream revision (anti-slop-upstream HEAD when the clone exists). */
const UPSTREAM_REVISION = '6d538555cb151d4121ed51a27db81890eacf8ae9'
const UPSTREAM_URL = 'https://github.com/dmmulroy/anti-slop'

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** All .ts files under a directory, recursively, excluding *.test.ts. */
function tsFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return tsFiles(path)
    if (entry.name.endsWith('.test.ts')) return []
    return extname(entry.name) === '.ts' ? [path] : []
  })
}

/** The set of files this repo vendors: rule sources + SKILL.md + install.mjs (skill-root-relative, forward-slash). */
function vendoredFiles() {
  const files = tsFiles(destination).map((path) => `assets/anti-slop/${relative(destination, path).split(sep).join('/')}`)
  files.push('SKILL.md')
  files.push('scripts/install.mjs')
  return files.sort()
}

function fileHash(relativePath, base) {
  return sha256(readFileSync(join(base, relativePath), 'utf8'))
}

function readManifest() {
  if (!existsSync(manifestPath)) return null
  return JSON.parse(readFileSync(manifestPath, 'utf8'))
}

function writeManifest() {
  const files = vendoredFiles()
  const hashes = {}
  for (const file of files) hashes[file] = fileHash(file, join(root, 'skills/install-anti-slop'))
  const manifest = {
    upstreamRevision: UPSTREAM_REVISION,
    upstreamUrl: UPSTREAM_URL,
    syncedFromClone: existsSync(join(upstreamRoot, '.git')),
    files: hashes,
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  return manifest
}

if (check) {
  let failures = 0
  const manifest = readManifest()
  if (manifest === null) {
    console.error('[FAIL] no vendored-manifest.json; run `node scripts/sync-vendored.mjs` first')
    process.exit(1)
  }
  if (manifest.upstreamRevision !== UPSTREAM_REVISION) {
    console.error(`[FAIL] manifest upstreamRevision ${manifest.upstreamRevision} != expected ${UPSTREAM_REVISION}`)
    failures++
  }
  const actual = vendoredFiles()
  const expected = Object.keys(manifest.files).sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error('[FAIL] vendored file set differs from manifest; run sync')
    failures++
  }
  for (const file of expected) {
    const actualHash = fileHash(file, join(root, 'skills/install-anti-slop'))
    if (actualHash !== manifest.files[file]) {
      console.error(`[FAIL] ${file} hash differs from manifest (${actualHash} != ${manifest.files[file]})`)
      failures++
    }
  }
  // When the upstream clone exists, byte-compare directly against its src.
  if (existsSync(upstreamSrc)) {
    for (const file of tsFiles(destination)) {
      const rel = relative(destination, file)
      const upstreamFile = join(upstreamSrc, rel)
      if (!existsSync(upstreamFile)) {
        console.error(`[FAIL] vendored ${rel} has no upstream src counterpart`)
        failures++
        continue
      }
      if (readFileSync(file, 'utf8') !== readFileSync(upstreamFile, 'utf8')) {
        console.error(`[FAIL] vendored ${rel} differs from upstream src`)
        failures++
      }
    }
    const ourSkill = join(root, 'skills/install-anti-slop/SKILL.md')
    const upSkill = join(upstreamRoot, 'skills/install-anti-slop/SKILL.md')
    const ourInstall = join(root, 'skills/install-anti-slop/scripts/install.mjs')
    const upInstall = join(upstreamRoot, 'skills/install-anti-slop/scripts/install.mjs')
    if (existsSync(upSkill) && !readFileSync(ourSkill, 'utf8').startsWith(readFileSync(upSkill, 'utf8'))) {
      console.error('[FAIL] SKILL.md does not start with the upstream body (DSH appendix must follow)')
      failures++
    }
    if (existsSync(upInstall) && readFileSync(ourInstall, 'utf8') !== readFileSync(upInstall, 'utf8')) {
      console.error('[FAIL] install.mjs differs from upstream')
      failures++
    }
  } else {
    console.log('NOTE: anti-slop-upstream clone absent; verified hashes against manifest only')
  }
  if (failures) {
    console.error(`[FAIL] vendored parity: ${failures} failure(s)`)
    process.exit(1)
  }
  console.log('OK vendored parity: assets match manifest' + (existsSync(upstreamSrc) ? ' and upstream src' : ''))
} else {
  if (!existsSync(upstreamSrc)) {
    console.error('anti-slop-upstream/src missing; clone upstream first:')
    console.error('  git -c http.sslVerify=false clone --depth 1 https://github.com/dmmulroy/anti-slop.git anti-slop-upstream')
    process.exit(1)
  }
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })
  cpSync(upstreamSrc, destination, {
    recursive: true,
    filter: (path) => !path.endsWith('.test.ts'),
  })
  // Skill body: upstream SKILL.md verbatim, then the DSH appendix (already in
  // our file; preserve it by re-writing only the upstream prefix).
  const skillPath = join(root, 'skills/install-anti-slop/SKILL.md')
  const upstreamSkill = readFileSync(join(upstreamRoot, 'skills/install-anti-slop/SKILL.md'), 'utf8')
  const appendixMarker = '\n---\n\n## DSH bundle appendix\n'
  const current = existsSync(skillPath) ? readFileSync(skillPath, 'utf8') : ''
  const appendix = current.includes(appendixMarker)
    ? current.slice(current.indexOf(appendixMarker))
    : ''
  writeFileSync(skillPath, upstreamSkill + appendix, 'utf8')
  cpSync(join(upstreamRoot, 'skills/install-anti-slop/scripts/install.mjs'),
    join(root, 'skills/install-anti-slop/scripts/install.mjs'), { force: true })
  const manifest = writeManifest()
  console.log(`Synced vendored assets (${Object.keys(manifest.files).length} files) at ${UPSTREAM_REVISION}`)
}
