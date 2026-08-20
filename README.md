# @try-works/dsh-anti-slop

DeepSeek Harness (DSH) bundle that brings [anti-slop](https://github.com/dmmulroy/anti-slop) Oxlint rules into the harness as a first-class lint tool, skill, command, and standing prompt section.

anti-slop is an **Oxlint rule plugin** (not a prose linter). It ships 15 generic TypeScript rules plus one opt-in Effect rule, aimed at rejecting "slop" patterns — e.g. exposing `unknown`, `any` or `any[]` from public API surfaces, relying on `Reflect.get`, or returning `unknown` from a callable.

## What this bundle provides

| Surface | Name | Purpose |
| --- | --- | --- |
| Tool | `anti_slop_lint` | Run the vendored anti-slop rules against a target file/dir via oxlint |
| Skill | `install-anti-slop` | Vendored copy of the upstream `install-anti-slop` skill (installs the rules into a target project's `tools/oxlint/anti-slop`) |
| Command | `/anti-slop` | Report the current project's oxlint/anti-slop install status |
| Prompt section | `anti-slop` | One-paragraph standing guidance telling the model the lint tool exists |

## Requirements

- DeepSeek Harness (the bundle is a DSH plugin; `dsh.bundle.patch` mounts it into an isolated `cordis` realm).
- `oxlint` available on the target machine's `PATH` (or set `oxlintBinary` in config). The harness itself ships oxlint, so this is normally satisfied automatically.
- `@oxlint/plugins@1.78.0` — declared as a runtime dependency so the vendored plugin can resolve it.

## Installation

```sh
npm i -D @try-works/dsh-anti-slop
```

Then add the bundle to your DSH config so `cordis.patch.yml` is applied, or install the skill manually into your harness.

## The `anti_slop_lint` tool

Parameters:

| Parameter | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `target` | string | yes* | `config.defaultTarget` | File or directory to lint. `*`Required unless `defaultTarget` is configured. |
| `rules` | string[] | no | all 15 generic rules | Subset of rule names; `anti-slop` plugin prefix is optional. |
| `effect` | boolean | no | `false` | Opt into the Effect rule (`no-service-constructor-imports`). |
| `fix` | boolean | no | `false` | Apply `--fix` (only valid with a single-file target). |
| `severity` | string | no | `error` | `error` \| `warn` \| `off`. |

The tool writes a **temporary** oxlint config (never into the target project), disables nested config and ignore files, and parses oxlint's JSON output into normalized findings.

Result statuses: `clean`, `findings`, `oxlint-not-found`, `error`.

## Configuration

```ts
// cordis realm config for the bundle entry
{
  enabledRules: ['no-unknown-returns', ...],  // defaults to all 15 generic rules
  defaultTarget: undefined,                    // optional default lint target
  effectRules: false,                          // opt-in Effect rules
  severity: 'error',                           // 'error' | 'warn' | 'off'
  oxlintBinary: undefined,                     // optional absolute oxlint path
  timeoutMs: 60_000,
}
```

## Skill

The `install-anti-slop` skill is the vendored upstream skill (SKILL.md + install script + the rule sources), bundled with this plugin. Invoking it from the harness copies the rule sources into the target project and wires them into that project's oxlint config.

## Upstream provenance

Vendored from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) at revision `6d538555cb151d4121ed51a27db81890eacf8ae9`.

- `skills/install-anti-slop/assets/anti-slop/**` — the rule plugin sources (verbatim upstream, excluding `*.test.ts`).
- `skills/install-anti-slop/SKILL.md` — upstream SKILL.md plus a `## DSH bundle appendix`.
- `skills/install-anti-slop/scripts/install.mjs` — upstream install script.
- `scripts/vendored-manifest.json` — SHA-256 manifest for byte-parity checks.

Run `pnpm run check:vendored` to verify byte-parity against the manifest and (when present) the upstream clone.

## Development

```sh
pnpm install
pnpm run typecheck     # tsc --noEmit
pnpm run test:unit     # vitest
pnpm run build         # tsc build
pnpm run verify        # typecheck + unit + parity + live boot smoke
pnpm run check:vendored
```

## License

MIT. The vendored anti-slop rule sources and skill are from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) and retain their original license/attribution (see `LICENSE.md`).
