# dsh-anti-slop: Implementation Plan

**Status:** Proposed — for review before implementation
**Date:** 2026-06-12
**Upstream:** https://github.com/dmmulroy/anti-slop (MIT)
**Reference:** `D:\DEV\dsh-paper-design` (existing DSH bundle)
**Harness checkout:** `D:\deepseek-harness` (for API reference only; the plugin lives in `D:\DEV\dsh-anti-slop`)

---

## 1. What upstream anti-slop actually is

Cloned to `D:\DEV\dsh-anti-slop\anti-slop-upstream` for analysis. It is **not** a prose/writing-style linter — it is an **opinionated Oxlint rule plugin** that rejects low-evidence / low-signal TypeScript and JavaScript patterns. The README's own framing: *"Opinionated Oxlint rules that reject low-evidence and low-signal TypeScript and JavaScript patterns."*

### Repo shape

```
anti-slop-upstream/
├── package.json                 # oxlint-plugin-anti-slop, private, v0.1.0, type: module, exports ./src/index.ts
├── tsconfig.json
├── src/
│   ├── index.ts                 # eslintCompatPlugin({meta:{name:"anti-slop"}, rules:{…}}) — 14 generic rules
│   ├── rules/                   # one file + one .test.ts per rule (RuleTester from "oxlint/plugins-dev")
│   └── shared/                  # dictionary-types.ts, lexical-type-parameters.ts, reflect-method.ts
├── src/effect/
│   ├── index.ts                 # eslintCompatPlugin({meta:{name:"anti-slop-effect"}, rules:{…}}) — 1 opt-in rule
│   └── rules/no-service-constructor-imports.ts (+ test)
├── scripts/sync-skill-assets.mjs  # copies src/*.ts (minus tests) into skills/install-anti-slop/assets/anti-slop; --check verifies
└── skills/install-anti-slop/      # the distribution mechanism:
    ├── SKILL.md                    # agent skill: copy plugin, install oxlint deps, merge config, enable rules
    └── scripts/install.mjs         # copies assets/anti-slop → tools/oxlint/anti-slop (refuses overwrite unless --force)
```

### The 14 generic rules

| Rule | Rejects |
|---|---|
| `no-chained-type-assertions` | `input as object as User` |
| `no-conditional-empty-object-spread` | `...(x ? {x} : {})` field omission |
| `no-known-value-widening` | explicit broad target types that discard known values (`Record<string, Handler>` over known keys) |
| `no-module-mocking` | Vitest/Jest `vi.mock` in favor of real seams |
| `no-object-parameters` | `object` on function inputs |
| `no-reflect-apply` / `no-reflect-get` | `Reflect.*` in favor of typed calls / boundary parsing |
| `no-runtime-typeof` | ad hoc `typeof` narrowing (option `allowInTypeGuards`) |
| `no-shape-in-symbol-names` | `shape` in symbol names |
| `no-unknown-parameters` | `unknown` inputs except the `cause` convention |
| `no-unknown-returns` | `unknown` / `Promise<unknown>` return contracts |
| `no-unknown-type-aliases` | aliases that conceal `unknown` |
| `no-unsafe-dictionary-type` | `Record<string, unknown|any|object|{}>` etc. |
| `no-widen-then-assert` | widen-then-reassert local flows |
| `require-safety-comment-for-type-assertion` | non-`const` assertions without a nearby `SAFETY:` comment |

Plus one **opt-in Effect rule** (`no-service-constructor-imports`) in a separate plugin so non-Effect projects inherit nothing.

### Distribution model

Upstream is deliberately **vendored, not a dependency**: `npx skills add dmmulroy/anti-slop --skill install-anti-slop`, then the agent skill copies `assets/anti-slop` into the target repo at `tools/oxlint/anti-slop/`, installs current `oxlint` + `@oxlint/plugins`, merges an `oxlint.config.ts` (`jsPlugins` + `ignorePatterns` + all rules at `"error"`), and validates. The skill also handles Vite+ `lint`/`fmt` configs and the Effect opt-in. `pnpm sync:skill-assets` keeps the bundled copy byte-identical to `src/`; CI checks it.

---

## 2. What "turn into a DSH plugin" should mean

The user owns the workspace `D:\DEV\dsh-anti-slop` (currently empty except the analysis clone). The goal: a **DSH host bundle** (`cordis.patch.yml` + `src/`) in the style of `dsh-paper-design` that a profile can add to `dsh.bundles` and get anti-slop **as a usable capability**, not as a repo the agent must clone manually.

The essential design decision is **how the rules run**. The upstream plugin is written against `@oxlint/plugins` (`defineRule` / `eslintCompatPlugin` / `ESTree`). There are four viable architectures; analysis favors a hybrid of A and B:

| Option | Mechanism | Pros | Cons | Verdict |
|---|---|---|---|---|
| **A. Bundle the rule sources + a native `ctx.tools` lint tool** | Ship upstream `src/` (vendored, parity-checked) inside the plugin; register a `tools`-service tool (`anti_slop_lint`) that shells out to the workspace's `oxlint` with the bundled plugin registered | Native tool, model-visible, honest lint UX, rule semantics stay exactly upstream | Requires `oxlint` + `@oxlint/plugins` present in the target project (dev deps, same major as harness's 1.76.x) | **Primary path** |
| B. In-process `@oxlint/linter` execution | Import the linter API directly in the plugin host, feed bundled rule objects | No subprocess; fast | New dependency surface; DSH host doesn't ship oxlint; API version coupling; heavier than needed | Defer |
| C. ESLint-compat re-export as a normal npm dep | Publish/reference `oxlint-plugin-anti-slop` as a peer dep | Simplest install | Violates upstream's "vendor, don't depend" intent; version drift; not how upstream distributes | Reject |
| D. Skill only | Ship the upstream `install-anti-slop` skill verbatim | Zero code | Doesn't make anti-slop a *native DSH capability*; still manual per-repo install | **Complement** |

So the plugin is: **vendored upstream rule sources (option A) + a native lint tool + the install skill + one command**, matching how `dsh-paper-design` ships sources directly and lets DSH load them via `tsx`.

### Why bundle rule sources instead of depending on the npm package

- Upstream's license/README philosophy is explicit: *"meant to be vendored, not treated as a fixed npm dependency."*
- The plugin's own `package.json` is `private: true` — it is not published.
- The rules are plain TypeScript importing only `@oxlint/plugins` types/runtime, so vendoring them is trivial and keeps parity checkable (mirror of upstream's `sync-skill-assets` pattern).

### Version pinning (the honest constraint)

The rules import `defineRule`/`eslintCompatPlugin`/`ESTree` from `@oxlint/plugins`. A JS-plugin is loaded by the **target project's** `oxlint`, so the plugin must tolerate the same major line as the harness's own pinned `oxlint 1.76.0` / `@oxlint/plugins 1.76.0`. Upstream currently pins 1.78.0. The vendored copy must therefore state its compatibility window (e.g. `^1.76.0`) and the install path must resolve the project's *current* versions (`npm view oxlint version`, per upstream's own skill guidance) rather than a hardcoded one.

---

## 3. Target architecture

```
dsh-anti-slop/
├── package.json               # @try-works/dsh-anti-slop (or user's scope), type: module, main: ./src/index.ts
│                              #   dsh.bundle.patch → ./cordis.patch.yml
│                              #   peerDeps: cordis, dsh-tools, dsh-system-prompt, dsh-skill, dsh-commands, dsh-subprocess
│                              #   (optional) devDeps pointing at D:\deepseek-harness\packages\… like dsh-paper-design
├── tsconfig.json / tsconfig.build.json
├── cordis.patch.yml           # insert anti-slop-realm (cordis:group, isolate) → mounts src/index.ts
├── src/
│   ├── index.ts               # plugin apply(): config, vendored-parity check, register tool + skill + command
│   ├── config.ts              # Config schema (Schemastery or plain type): rules on/off, target, severity
│   ├── lint.ts                # the anti_slop_lint tool: resolve oxlint binary, build argv, run via ctx.subprocess, parse output
│   ├── project.ts             # locate project root (nearest .git or cwd), find oxlint.config, detect existing anti-slop
│   ├── rules-registry.ts      # static registry mapping public rule names → upstream rule ids
│   ├── parity.ts              # vendored-asset parity check vs skills/…/assets/anti-slop (mirror upstream sync-skill-assets)
│   └── skills.ts              # runtime registration of the bundled install-anti-slop skill
├── skills/install-anti-slop/  # upstream skill + assets (vendored, parity-checked), adapted minimally
│   ├── SKILL.md               # unchanged except DSH-specific install guidance appended
│   ├── scripts/install.mjs    # unchanged (copy assets/anti-slop → target)
│   └── assets/anti-slop/      # byte-identical to the vendored rule sources (upstream's own layout)
├── scripts/
│   ├── sync-vendored.mjs      # fetch/refresh upstream src + skill into this repo (or copy from anti-slop-upstream/)
│   └── verify.mjs             # boot plugin in-process, exercise tool/command, parity check
├── tests/                     # vitest: tool argv construction, output parsing, parity, config defaults
└── README.md
```

### The `anti_slop_lint` tool (the core capability)

Registered via `ctx.tools.register` exactly like `dsh-paper-design` registers `paper_*` tools. Model-visible contract:

- **name:** `anti_slop_lint`
- **parameters:**
  - `target` (string, optional) — file or directory; defaults to the session cwd
  - `rules` (array of strings, optional) — subset of the 14 rule names; defaults to all generic rules (or config)
  - `effect` (boolean, optional, default false) — include the Effect rule group
  - `fix` (boolean, optional, default false) — pass `--fix` (only meaningful with explicit `target`)
- **execute:** build and run, **return a structured result** (lint outcome, not raw process output — the canonical value is the parsed findings; full output goes to the result text so nothing is lost):
  - Resolve the project root for `target` (nearest `.git` ancestor; fallback `ctx.scope`/cwd).
  - Resolve `oxlint` from the project: `ctx.subprocess.resolveExecutable('oxlint', …)`; if missing → helpful error telling the model the project needs `oxlint` + `@oxlint/plugins` dev deps (and that the bundled `install-anti-slop` skill sets them up).
  - Confirm the target project has (or create on `--fix`? no — **do not mutate** the target's config from the tool; the skill owns config writes) an anti-slop registration; if absent → return a "not installed" result pointing at the skill, rather than silently linting with zero rules.
  - Run `oxlint --stdin` for a single file or `oxlint <dir>` for a directory, with the anti-slop rules passed via the project's `oxlint.config` (preferred) or explicit `--rule` flags (fallback), and `--deny-warnings` semantics left to the caller.
  - Parse the text output into `{ rule, file, line, message, severity }[]` (or pass through JSON with `--format json` when available).
  - Wire cancellation through `exec.signal` → subprocess `abortSignal`.
  - **File-write policy:** the tool is read-only with respect to the target repo (lint only). `fix: true` is an explicit opt-in per call, and even then only with an explicit single-file/dir target; never rewrite a project's lint config.

### Prompt surface

- Standing **system-prompt section** (order in the tool-guidance band, e.g. `150`, same band as paper-design) that explains: when and how to use `anti_slop_lint`, the default rule set, and that `unknown`-contract/`Reflect`/`typeof`/assertion patterns are rejected — one short paragraph, not a wall of text (this is *guidance*, not the full rule spec; the skill body is the progressive-disclosure index).
- The full per-rule rationale lives in the bundled skill body (progressive disclosure), so the prompt stays small and the tool + skill carry the detail.

### The bundled skill

- `install-anti-slop` (upstream body, verbatim) registered at runtime via `ctx.skills.register({ …, resourceBase: { kind: 'directory', path: <bundled skills dir> } })` so the model can read `scripts/install.mjs` and the vendored rule sources when asked to install/configure anti-slop in a repo.
- Rationale for shipping it as the DSH skill rather than only the tool: the tool lints; the skill *installs and configures* — exactly the split upstream designed, and it keeps parity with upstream's own artifact.

### Command

- `/anti-slop` — status + help: whether the current project has oxlint + anti-slop registered, which rules are enabled, and pointers to the tool and the install skill. (Mirrors `/paper-reconnect` style: a small command service surface.)

### Bundle patch (cordis.patch.yml)

Mirror `dsh-paper-design`'s pattern — the `cordis:group` realm keeps registrations out of the root realm so the bundle can be composed more than once without colliding:

```yaml
- insert:
    - id: anti-slop-realm
      name: cordis:group
      isolate:
        antiSlop: true
      config:
        - id: anti-slop
          name: '@try-works/dsh-anti-slop/src/index.ts'
```

### Service dependencies (`inject`)

`['tools', 'systemPrompt', 'skills', 'commands']`, plus runtime `ctx.get('subprocess')` (like paper-design resolves `attachments` via `ctx.get`) so linting works when the profile mounts `dsh-subprocess-local` (base does). A profile lacking subprocess gets the tool (which reports the runtime unavailable) — matching paper-design's "text tools work even without the attachment store" posture.

### Config

Schemastery `Config` (like other DSH plugins):
- `enabledRules`: subset of the 14 (default: all)
- `defaultTarget`: string | undefined (default: session cwd)
- `effectRules`: boolean (default: false)
- `severity`: `'error' | 'warn'` (default: `'error'`)
- `oxlintBinary`: string | undefined (default: resolve from project)
- `timeoutMs`: number (default: 60000, aligned with bash-sandbox default)

---

## 4. Delivery steps (ordered, each independently verifiable)

1. **Scaffold the package** (package.json, tsconfigs, cordis.patch.yml, README skeleton) modeled on `dsh-paper-design`; `devDependencies` point at the harness checkout paths (`file:D:/deepseek-harness/packages/…`) exactly like the reference, and at the harness's pinned `oxlint`/`@oxlint/plugins` versions for local dev parity.
2. **Vendor upstream sources** — copy `anti-slop-upstream/src/**` (rules, shared, effect) + `skills/install-anti-slop/**` into the plugin tree under `skills/…/assets/anti-slop/` and a `vendor/` mirror; write `scripts/sync-vendored.mjs` (copy + parity `--check`) mirroring upstream's own sync script, and add the parity check to `verify`.
3. **Implement `src/lint.ts`** — oxlint resolution, argv building, `ctx.subprocess` spawn (collect mode, abort signal), output parsing → structured findings. Unit-test argv construction and parsing with fixtures (no oxlint needed for unit tests).
4. **Implement `src/project.ts` + `src/rules-registry.ts` + `src/config.ts`** — project-root detection, existing-config detection, rule-name registry, config schema.
5. **Implement `src/index.ts` apply()** — register tool, prompt section, skill (with `resourceBase`), command; wire config → tool defaults; effect-based cleanup (disposers, `ctx.effect`).
6. **Adapt the skill** — ship upstream `install-anti-slop` verbatim plus a short DSH-specific appendix ("when using inside DSH, you can also call `anti_slop_lint`; do not enable rules in DSH-managed checkouts you do not own").
7. **Tests + verify scripts** — vitest unit tests (argv, parsing, parity, config), `scripts/verify.mjs` in-process plugin boot (mirror `dsh-paper-design/scripts/boot-plugin.mts`), plus a live smoke test against the harness checkout or a fixture repo with oxlint installed.
8. **README + profile install docs** — the `dsh.bundles` snippet (mirroring paper-design's), usage, development commands (`pnpm run build`, `pnpm run verify`), and a "known limitations" section (rule sources track upstream 1.78 line; harness pins 1.76; oxlint must be installed in the linted project).

## 5. Verification / acceptance

- `pnpm run build` — `tsc -p tsconfig.build.json` clean.
- `pnpm test` — vitest green: argv, parsing, parity, config.
- `scripts/verify.mjs` — boots the plugin in-process against a `Context` with the real `tools`/`skills`/`commands` services (or mocks), asserts the tool registers with the right schema, the skill registers with a directory resource base, the command registers, and cleanup disposes everything.
- Live smoke (documented, manual): create a scratch project with `oxlint@1.76` + `@oxlint/plugins@1.76`, run `anti_slop_lint` against a file with a known violation (`function load(): unknown {}`), expect a finding for `anti-slop/no-unknown-returns`.
- Parity: `sync-vendored.mjs --check` reports vendored sources identical to upstream (or a recorded, reviewed delta).

## 6. Risks / open decisions

| Risk | Mitigation |
|---|---|
| `@oxlint/plugins` API drift between 1.76 (harness) and 1.78 (upstream) | Pin the vendored copy to the harness's 1.76 line for local dev; document the window; the tool lints with the *project's* oxlint, so the project pins what it wants. Verify live against both versions in step 7. |
| oxlint absent in target project | Tool returns a structured "not installed" result pointing at the install skill; never silently no-ops. |
| Tool runs with no anti-slop rules registered in target config | Same "not installed" path (detect `jsPlugins`/`rules` containing `anti-slop` before running); the tool does **not** edit the target's config. |
| Rule semantics drift if upstream changes | `sync-vendored.mjs --check` in CI; deliberate, reviewed deltas recorded. |
| Windows path/quoting for the subprocess spawn | Unit-test argv with Windows-style paths; use `ctx.subprocess` (which already handles the platform) rather than shell strings. |
| Prompt bloat | Standing section is one paragraph; full detail lives in the skill + tool description. |
| Scope/naming | **DECIDED:** `@try-works/dsh-anti-slop` (user confirmed, matching the reference plugin's scope). |
| Should the Effect rule group be included by default? | **DECIDED:** off by default, toggleable via config (`effectRules`) or the tool's `effect` flag — mirrors upstream's opt-in philosophy. |

## 7. Explicit non-goals

- No in-process `@oxlint/linter` execution path (option B) in v1 — the subprocess seam is the supported way and keeps the oxlint version owned by the linted project.
- No publishing/updating of upstream as an npm dependency (option C).
- No rewriting of a target project's lint config from the tool — that is the skill's job.
- No new AST logic — every rule is upstream's, verbatim; this plugin is a *carrier*, not a rule author.

## 8. Sources

- Upstream repo (cloned locally): https://github.com/dmmulroy/anti-slop — README, `src/index.ts`, `src/rules/*`, `skills/install-anti-slop/{SKILL.md,scripts/install.mjs}`, `scripts/sync-skill-assets.mjs`.
- DSH plugin reference: `D:\DEV\dsh-paper-design` — `cordis.patch.yml`, `src/index.ts`, `src/skills.ts`, `package.json`, README.
- Harness docs: `docs/cordis-primer.md`, `docs/cookbook/adding-a-tool.md`, `packages/subprocess/subprocess/README.md`, `packages/subprocess/subprocess-local/README.md`, `packages/skill/skill-filesystem/README.md`, `packages/skill/skill/src/index.ts` (registration + `resourceBase`), `packages/bundle/base/cordis.patch.yml`, `packages/bundle/web-app/cordis.patch.yml`, harness `.oxlintrc.json` + root `package.json` (oxlint 1.76.0).
