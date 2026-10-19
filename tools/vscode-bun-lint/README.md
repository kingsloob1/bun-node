# vscode-bun-lint

The bun-node repository's VS Code extension for `bun lint` and `bun fmt`
([`docs/plans/bun-lint-fmt/`](../../docs/plans/bun-lint-fmt/README.md), §5).
It shows `bun lint`'s findings as you type, offers its fixes and suggestions as
quick fixes, and formats with `bun fmt`. It replaces the ESLint extension when
the repository switches to `bun lint` (PR E of the plan); until then it is
**opt-in**, and the repository's `.vscode` settings do not mention it.

It is not published. It lives here, outside the workspaces, with its own
`package.json` and `bun.lock`, and is deleted once Bun ships an editor
integration of its own (`bun lint --lsp` is "Not supported" today).

## Install

It needs **Bun 1.4.4 or later** (until 1.4.4 is stable, the canary:
`bun upgrade --canary`), the repository's development floor.

```bash
cd tools/vscode-bun-lint
bun install --frozen-lockfile
bun run package                 # dist/vscode-bun-lint.vsix
code --install-extension dist/vscode-bun-lint.vsix
```

`bun run package` bundles `src/extension.ts` with `Bun.build`
(`scripts/build.ts`: one CommonJS file, `dist/extension.js`, with `vscode`
left to the host) and packs it with `bunx @vscode/vsce`, which is not a
dependency. vsce joins a relative README link onto `--baseContentUrl`
(this folder on GitHub's `develop`) by plain concatenation, which a browser
normalises to the right file; the `repository` field alone would give
`blob/HEAD/../../…`, which leaves the repository. Reinstall the same way after pulling a change here. To remove it:
`code --uninstall-extension kingsleyweb.vscode-bun-lint`.

To work on the extension itself, `bun run build` and start VS Code with
`code --extensionDevelopmentPath="$PWD" <repo>`; reload the window after each
build.

## Enable it

Installed, it lints and offers its formatter at once in this repository and
nowhere else: it runs only on a file whose nearest `bunfig.toml` has a
`[lint]` section (or `[fmt]`, to format), which is Bun's own config lookup
(`bunLint.requireConfig`).

Until PR E, the ESLint extension is still the repository's, so both report.
To use this one alone, disable the ESLint extension for the workspace
(Extensions view → ESLint → Disable (Workspace)). To format with `bun fmt`,
in your user or workspace settings:

```jsonc
{
  "editor.defaultFormatter": "kingsleyweb.vscode-bun-lint",
  "editor.formatOnSave": true,
  // Optional: apply bun lint's automatic fixes on save.
  "editor.codeActionsOnSave": { "source.fixAll.bunLint": "explicit" }
}
```

Do not run `bun fmt` over whole directories, or format files on save, before
PR E's one-time reformat: Prettier, through ESLint, is still the gate, and the
two disagree on 78 files (plan §7, PR A).

## What it does

- **Diagnostics** on open, on save and, 500 ms after the last change
  (`bunLint.debounceMs`; `bunLint.run: "onSave"` for open and save only),
  from `bun lint --stdin --stdin-filename <file> -f json` with the buffer on
  standard input, so unsaved text is linted. The root `bunfig.toml` has
  `typeAware = true`, so the type-aware rules run in the editor too, typed by
  the file's own `tsconfig.json` (the bun-jobs-ui app's has the DOM). Errors
  and warnings keep the config's severities. The rule name in the Problems
  panel and the hover links to `bun lint --explain=<rule>`, served as a
  read-only page (the "Show documentation" quick fix opens the same page
  beside the file).
  A newer run kills the one it replaces.
- **Quick fixes**: "Fix this … problem" for a finding with a `fix`, one
  action per `suggestions` entry, "Show documentation for …", and "Fix all
  auto-fixable problems in this file", which applies every fix one pass can
  apply together (ESLint's rule: overlapping fixes wait for the next pass).
  The same is the `source.fixAll.bunLint` action and the
  **Bun Lint: Fix all auto-fixable problems in this file** command.
- **Formatting**: Format Document, Format Selection (`--range-start` /
  `--range-end`, which count UTF-16 units, as VS Code does) and format on
  save, from `bun fmt --stdin-filepath <file>`, as one minimal edit. For
  JavaScript, TypeScript, JSX/TSX, JSON (and JSONC, JSON5), CSS, SCSS, Less,
  HTML, YAML, TOML, Vue, GraphQL and Svelte; not Markdown, which the
  repository does not format. A file `bun fmt` cannot parse is left alone,
  with a status-bar note and the error in the output channel.
- **Fails visibly**: before the first run it checks `bun --version` against
  1.4.4. An older Bun, or no `bun` at all, is one notification naming the fix,
  and nothing else runs. (On 1.4.3, `bun lint` in a package whose `lint`
  script is `bun lint` would run that script again, forever.) A report that is
  not JSON is one notification per distinct error. **Bun Lint: Show output**
  has every run, its time and its errors.

### How it runs Bun

- **From the file's directory.** Bun reads the `bunfig.toml` nearest the
  working directory, so every directory of the repository gets the root one
  and `templates/compute-provider/` its own. In a directory whose
  `package.json` has a `lint` script, `bun lint` runs that script ("your
  script wins"), from the package's directory, with the extension's flags
  appended. **The extension relies on that script being exactly
  `bun lint`**, as all eleven are, which makes the result the gate's. A
  composite script (`bun lint && …`, `eslint .`) shows up as a notification
  that the report is not JSON, naming the script. The file name is passed
  absolute because a relative one would be resolved from the package
  directory.
- **Without `AGENT`, `CLAUDECODE` and `REPL_ID`** in the child's
  environment: they switch Bun's output to the format meant for AI agents.
- **With `-f json`, `--no-warn-ignored` and `--no-color`**: the machine
  report, nothing for an ignored file (`dist/`, `dts/`).

## Settings

| Setting | Default | |
|---|---|---|
| `bunLint.enable` | `true` | Diagnostics and quick fixes. |
| `bunLint.format.enable` | `true` | The formatter. |
| `bunLint.bunPath` | `"bun"` | The binary: a name on `PATH` or an absolute path. A VS Code started from the desktop may not have `~/.bun/bin` on its `PATH`. |
| `bunLint.run` | `"onType"` | `"onSave"` lints on open and save only. |
| `bunLint.debounceMs` | `500` | The wait after the last change. |
| `bunLint.requireConfig` | `true` | Run only under a `bunfig.toml` with `[lint]` / `[fmt]`. |

It does not run in an untrusted workspace: it executes `bun` on the files.

## Compared with the ESLint extension

Lost: diagnostics for Markdown and JSON files (no native rules), the rules
the plan drops (§3), "Fix all ESLint problems" across the workspace
(`bun lint --fix` from a terminal does that) and the "disable this rule"
actions. Gained: the type-aware rules, which ESLint never ran here.

## Development

```bash
bun run test        # bun test --check
bun run lint        # bun lint
bun run lint:eslint # the gate until PR E
bun --check         # or bun scripts/typecheck.ts from the root, which lists this project
```

`src/core/` holds everything that does not need VS Code (the arguments, the
environment, the floor check, the report mapping, the edits), and
`src/extension.ts` adapts it to the `vscode` API. The tests:

- `report`, `edits`, `bun`, `config`: the mapping from the JSON report, the
  formatting and fix edits, the child process and the floor, the config
  lookup.
- `format`: `bun fmt` through the extension's `formatText`.
- `directories`: in each of the eleven directories the gate lints, a real
  file is clean through the extension as it is in the gate (`bun lint` over
  the whole directory), and with planted lines reports exactly the planted
  findings, by rule, line and severity, and the same problems as the CLI run
  from that directory. The plants show each directory gets its own config:
  `regexp/*` everywhere but the template, `no-console` off in `scripts/`,
  `playground/` and `examples/`, the type-aware `no-floating-promises`
  everywhere, and the React rules under their override
  (`packages/bun-jobs-ui/**` and `examples/bun-jobs-ui/**`): `jsx-key` and
  `only-export-components` in a `.tsx` component, `rules-of-hooks` (error)
  and `exhaustive-deps` (warning) in a `.ts` hook in `app/` and `lib/`, and
  none of them in bun-common. In `__tests__/app/**`, the DOM-typed
  `no-unnecessary-type-assertion` is reported and the `no-unsafe-*` rules are
  off (the test override); each has a control where it does not hold.
- `package`: `bun run package` as written exits 0, packs five files, and
  every README link resolves to a file in the repository. It needs the
  network once, for `bunx @vscode/vsce`, and `unzip`.
- `extension`: `activate()` against a fake `vscode` module with the real
  `bun` behind it: the diagnostics, the quick fixes, "Fix all", the
  formatters, the explain page and the single notification for an old Bun.

The tests do not start a real extension host (`@vscode/test-electron` would
download VS Code and needs a display); the bundle was installed into a
throwaway `--extensions-dir` to check that it packs and installs.
