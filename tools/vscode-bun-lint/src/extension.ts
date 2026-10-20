/**
 * The VS Code side: diagnostics from `bun lint`, quick fixes from its fixes
 * and suggestions, "Fix all", and `bun fmt` through the formatter API. Every
 * call to Bun goes through `core/service.ts`; this file only adapts between
 * VS Code's objects and the neutral ones there.
 */
import type { BunCheck } from "./core/bun";
import type { OffsetEdit } from "./core/edits";
import type { Problem } from "./core/report";
import process from "node:process";
import * as vscode from "vscode";
import { checkBun } from "./core/bun";
import { isConfigured } from "./core/config";
import { fixEdits } from "./core/edits";
import { ReportError } from "./core/report";
import {
  CancelledError,
  explainRule,
  formatText,
  lintText,
} from "./core/service";

/** The diagnostics' `source`, and the output channel's name. */
export const SOURCE = "bun lint";

/** The scheme of a rule's documentation page (`bun lint --explain`). */
export const EXPLAIN_SCHEME = "bun-lint-explain";

/** The kind of the "Fix all" source action, for `editor.codeActionsOnSave`. */
export const FIX_ALL_KIND = "source.fixAll.bunLint";

/** Languages `bun lint` lints. */
export const LINT_LANGUAGES = [
  "javascript",
  "javascriptreact",
  "typescript",
  "typescriptreact",
];

/**
 * Languages `bun fmt` formats (each measured through `--stdin-filepath`),
 * without Markdown, which the repo does not format (plan Q3).
 */
export const FORMAT_LANGUAGES = [
  ...LINT_LANGUAGES,
  "json",
  "jsonc",
  "json5",
  "css",
  "scss",
  "less",
  "html",
  "yaml",
  "toml",
  "vue",
  "graphql",
  "svelte",
];

/** What the last finished lint of a document found. */
interface LintState {
  /** The document version it ran on. */
  version: number;
  /** Its problems. */
  problems: Problem[];
}

/** The extension's settings, read fresh on each use. */
interface Settings {
  /** `bunLint.enable`. */
  enable: boolean;
  /** `bunLint.format.enable`. */
  formatEnable: boolean;
  /** `bunLint.bunPath`. */
  bunPath: string;
  /** `bunLint.run`. */
  run: "onType" | "onSave";
  /** `bunLint.debounceMs`. */
  debounceMs: number;
  /** `bunLint.requireConfig`. */
  requireConfig: boolean;
}

/**
 * Reads the settings.
 * @returns The current values, with the defaults of `package.json`.
 */
function settings(): Settings {
  const c = vscode.workspace.getConfiguration("bunLint");
  return {
    enable: c.get<boolean>("enable", true),
    formatEnable: c.get<boolean>("format.enable", true),
    bunPath: c.get<string>("bunPath", "bun") || "bun",
    run: c.get<"onType" | "onSave">("run", "onType"),
    debounceMs: c.get<number>("debounceMs", 500),
    requireConfig: c.get<boolean>("requireConfig", true),
  };
}

/**
 * The editor range of a problem.
 * @param p The problem.
 * @returns Its range.
 */
function problemRange(p: Problem): vscode.Range {
  return new vscode.Range(
    p.start.line,
    p.start.character,
    p.end.line,
    p.end.character,
  );
}

/**
 * The documentation link of a rule.
 * @param rule The rule id.
 * @returns A URI the explain provider serves.
 */
export function explainUri(rule: string): vscode.Uri {
  return vscode.Uri.from({ scheme: EXPLAIN_SCHEME, path: `/${rule}` });
}

/**
 * A problem as a diagnostic, its rule linking to `bun lint --explain`.
 * @param p The problem.
 * @returns The diagnostic.
 */
export function toDiagnostic(p: Problem): vscode.Diagnostic {
  const d = new vscode.Diagnostic(
    problemRange(p),
    p.message,
    p.severity === "error"
      ? vscode.DiagnosticSeverity.Error
      : vscode.DiagnosticSeverity.Warning,
  );
  d.source = SOURCE;
  if (p.rule !== undefined)
    d.code = { value: p.rule, target: explainUri(p.rule) };
  return d;
}

/**
 * The key matching a diagnostic VS Code hands back to the problem behind it.
 * @param range Its range.
 * @param message Its message.
 * @param rule Its rule.
 * @returns The key.
 */
function keyOf(
  range: vscode.Range,
  message: string,
  rule: string | undefined,
): string {
  return `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}|${rule ?? ""}|${message}`;
}

/**
 * The rule of a diagnostic, as `toDiagnostic` set it.
 * @param d The diagnostic.
 * @returns The rule id, or `undefined`.
 */
function ruleOf(d: vscode.Diagnostic): string | undefined {
  const code = d.code;
  if (code === undefined) return undefined;
  if (typeof code === "object") return String(code.value);
  return String(code);
}

/**
 * Offset edits as a workspace edit on one document.
 * @param document The document the offsets belong to.
 * @param edits The edits.
 * @returns The workspace edit.
 */
function workspaceEdit(
  document: vscode.TextDocument,
  edits: OffsetEdit[],
): vscode.WorkspaceEdit {
  const we = new vscode.WorkspaceEdit();
  for (const e of edits)
    we.replace(
      document.uri,
      new vscode.Range(
        document.positionAt(e.start),
        document.positionAt(e.end),
      ),
      e.text,
    );
  return we;
}

/**
 * Starts the extension.
 * @param context VS Code's extension context.
 */
export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Bun Lint");
  const diagnostics = vscode.languages.createDiagnosticCollection(SOURCE);
  const state = new Map<string, LintState>();
  const running = new Map<string, AbortController>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const notified = new Set<string>();
  let check: { bunPath: string; result: Promise<BunCheck> } | undefined;

  const log = (line: string) =>
    output.appendLine(`[${new Date().toISOString()}] ${line}`);

  /** One notification per distinct message, then only the output channel. */
  const notifyOnce = (message: string) => {
    log(message);
    if (notified.has(message)) return;
    notified.add(message);
    void vscode.window
      .showErrorMessage(`Bun Lint: ${message}`, "Show output")
      .then((pick) => {
        if (pick) output.show(true);
      });
  };

  const cwdFor = () =>
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

  /** The floor check, once per `bunPath`; a failure is one notification. */
  const ensureBun = async (bunPath: string): Promise<boolean> => {
    if (check?.bunPath !== bunPath)
      check = { bunPath, result: checkBun(bunPath, cwdFor()) };
    const result = await check.result;
    if (!result.ok) notifyOnce(result.reason);
    else if (!notified.has(`version ${result.version}`)) {
      notified.add(`version ${result.version}`);
      log(`using ${bunPath} ${result.version}`);
    }
    return result.ok;
  };

  const shouldLint = (document: vscode.TextDocument, s: Settings) =>
    s.enable &&
    document.uri.scheme === "file" &&
    LINT_LANGUAGES.includes(document.languageId) &&
    (!s.requireConfig || isConfigured(document.uri.fsPath, "lint"));

  const shouldFormat = (document: vscode.TextDocument, s: Settings) =>
    s.formatEnable &&
    document.uri.scheme === "file" &&
    (!s.requireConfig || isConfigured(document.uri.fsPath, "fmt"));

  const clear = (uri: vscode.Uri) => {
    const key = uri.toString();
    running.get(key)?.abort();
    running.delete(key);
    clearTimeout(timers.get(key));
    timers.delete(key);
    state.delete(key);
    diagnostics.delete(uri);
  };

  const lint = async (document: vscode.TextDocument) => {
    const s = settings();
    const key = document.uri.toString();
    if (!shouldLint(document, s)) {
      if (state.has(key) || diagnostics.has(document.uri)) clear(document.uri);
      return;
    }
    if (!(await ensureBun(s.bunPath))) return;
    running.get(key)?.abort();
    const controller = new AbortController();
    running.set(key, controller);
    const version = document.version;
    const started = Date.now();
    try {
      const problems = await lintText(document.uri.fsPath, document.getText(), {
        bunPath: s.bunPath,
        signal: controller.signal,
      });
      if (controller.signal.aborted || document.isClosed) return;
      state.set(key, { version, problems });
      diagnostics.set(document.uri, problems.map(toDiagnostic));
      log(
        `linted ${vscode.workspace.asRelativePath(document.uri)} in ${Date.now() - started} ms: ${problems.length} problem(s)`,
      );
    } catch (error) {
      if (error instanceof CancelledError) {
        if (!controller.signal.aborted)
          log(`bun lint timed out on ${document.uri.fsPath}`);
        return;
      }
      if (error instanceof ReportError && error.stderr.trim() !== "")
        log(error.stderr.trim());
      notifyOnce(error instanceof Error ? error.message : String(error));
    } finally {
      if (running.get(key) === controller) running.delete(key);
    }
  };

  const schedule = (document: vscode.TextDocument, delay: number) => {
    const key = document.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        void lint(document);
      }, delay),
    );
  };

  const lintAllOpen = () => {
    for (const document of vscode.workspace.textDocuments) void lint(document);
  };

  /** The problems of the last lint, when it ran on this exact version. */
  const current = (document: vscode.TextDocument): Problem[] | undefined => {
    const s = state.get(document.uri.toString());
    return s?.version === document.version ? s.problems : undefined;
  };

  /** Fresh fixes for "Fix all": a lint of the buffer as it is now. */
  const fixAllEdit = async (
    document: vscode.TextDocument,
  ): Promise<vscode.WorkspaceEdit | undefined> => {
    const s = settings();
    if (!shouldLint(document, s) || !(await ensureBun(s.bunPath)))
      return undefined;
    const problems =
      current(document) ??
      (await lintText(document.uri.fsPath, document.getText(), {
        bunPath: s.bunPath,
      }));
    const edits = fixEdits(problems.flatMap((p) => (p.fix ? [p.fix] : [])));
    return edits.length > 0 ? workspaceEdit(document, edits) : undefined;
  };

  const codeActions: vscode.CodeActionProvider = {
    async provideCodeActions(document, _range, context) {
      const actions: vscode.CodeAction[] = [];
      const fixAllKind = vscode.CodeActionKind.SourceFixAll.append("bunLint");
      if (context.only?.contains(fixAllKind)) {
        const edit = await fixAllEdit(document);
        if (edit) {
          const action = new vscode.CodeAction(
            "Fix all auto-fixable bun lint problems",
            fixAllKind,
          );
          action.edit = edit;
          actions.push(action);
        }
        return actions;
      }
      const problems = current(document);
      if (!problems) return actions;
      const byKey = new Map(
        problems.map((p) => [keyOf(problemRange(p), p.message, p.rule), p]),
      );
      const explained = new Set<string>();
      for (const d of context.diagnostics) {
        if (d.source !== SOURCE) continue;
        const rule = ruleOf(d);
        const p = byKey.get(keyOf(d.range, d.message, rule));
        if (!p) continue;
        if (p.fix) {
          const action = new vscode.CodeAction(
            p.rule ? `Fix this ${p.rule} problem` : "Fix this problem",
            vscode.CodeActionKind.QuickFix,
          );
          action.edit = workspaceEdit(document, [
            { start: p.fix.range[0], end: p.fix.range[1], text: p.fix.text },
          ]);
          action.diagnostics = [d];
          action.isPreferred = true;
          actions.push(action);
        }
        for (const sug of p.suggestions) {
          const action = new vscode.CodeAction(
            `${sug.desc}${p.rule ? ` (${p.rule})` : ""}`,
            vscode.CodeActionKind.QuickFix,
          );
          action.edit = workspaceEdit(document, [
            {
              start: sug.fix.range[0],
              end: sug.fix.range[1],
              text: sug.fix.text,
            },
          ]);
          action.diagnostics = [d];
          actions.push(action);
        }
        if (p.rule && !explained.has(p.rule)) {
          explained.add(p.rule);
          const action = new vscode.CodeAction(
            `Show documentation for ${p.rule}`,
            vscode.CodeActionKind.QuickFix,
          );
          action.command = {
            title: action.title,
            command: "bunLint.explainRule",
            arguments: [p.rule],
          };
          actions.push(action);
        }
      }
      const fixable = problems.filter((p) => p.fix).length;
      if (fixable > 0 && actions.length > 0) {
        const action = new vscode.CodeAction(
          `Fix all auto-fixable problems in this file (${fixable})`,
          vscode.CodeActionKind.QuickFix,
        );
        action.edit = workspaceEdit(
          document,
          fixEdits(problems.flatMap((p) => (p.fix ? [p.fix] : []))),
        );
        actions.push(action);
      }
      return actions;
    },
  };

  const format = async (
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
    range?: vscode.Range,
  ): Promise<vscode.TextEdit[]> => {
    const s = settings();
    if (!shouldFormat(document, s) || !(await ensureBun(s.bunPath))) return [];
    const controller = new AbortController();
    const sub = token.onCancellationRequested(() => controller.abort());
    try {
      const edit = await formatText(document.uri.fsPath, document.getText(), {
        bunPath: s.bunPath,
        signal: controller.signal,
        range: range
          ? {
              start: document.offsetAt(range.start),
              end: document.offsetAt(range.end),
            }
          : undefined,
      });
      if (!edit || token.isCancellationRequested) return [];
      return [
        vscode.TextEdit.replace(
          new vscode.Range(
            document.positionAt(edit.start),
            document.positionAt(edit.end),
          ),
          edit.text,
        ),
      ];
    } catch (error) {
      if (error instanceof CancelledError) return [];
      // A syntax error is the user's to fix, not a broken tool: log it and
      // say so in the status bar, without a notification on every save.
      log(
        `bun fmt ${document.uri.fsPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
      vscode.window.setStatusBarMessage(
        "$(warning) bun fmt could not format this file (see Bun Lint output)",
        5000,
      );
      return [];
    } finally {
      sub.dispose();
    }
  };

  const formatSelector = FORMAT_LANGUAGES.map((language) => ({
    language,
    scheme: "file",
  }));
  const lintSelector = LINT_LANGUAGES.map((language) => ({
    language,
    scheme: "file",
  }));

  context.subscriptions.push(
    output,
    diagnostics,
    vscode.workspace.registerTextDocumentContentProvider(EXPLAIN_SCHEME, {
      provideTextDocumentContent: (uri) =>
        explainRule(uri.path.replace(/^\//, ""), cwdFor(), {
          bunPath: settings().bunPath,
        }),
    }),
    vscode.languages.registerCodeActionsProvider(lintSelector, codeActions, {
      providedCodeActionKinds: [
        vscode.CodeActionKind.QuickFix,
        vscode.CodeActionKind.SourceFixAll.append("bunLint"),
      ],
    }),
    vscode.languages.registerDocumentFormattingEditProvider(formatSelector, {
      provideDocumentFormattingEdits: (document, _options, token) =>
        format(document, token),
    }),
    vscode.languages.registerDocumentRangeFormattingEditProvider(
      formatSelector,
      {
        provideDocumentRangeFormattingEdits: (
          document,
          range,
          _options,
          token,
        ) => format(document, token, range),
      },
    ),
    vscode.workspace.onDidOpenTextDocument((document) => void lint(document)),
    vscode.workspace.onDidSaveTextDocument((document) => void lint(document)),
    vscode.workspace.onDidChangeTextDocument((event) => {
      const s = settings();
      if (s.run === "onType" && event.contentChanges.length > 0)
        schedule(event.document, s.debounceMs);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => clear(document.uri)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("bunLint")) return;
      check = undefined;
      notified.clear();
      lintAllOpen();
    }),
    vscode.commands.registerCommand("bunLint.fixAll", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const edit = await fixAllEdit(editor.document);
      if (edit) await vscode.workspace.applyEdit(edit);
    }),
    vscode.commands.registerCommand("bunLint.lintActive", async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) await lint(editor.document);
    }),
    vscode.commands.registerCommand("bunLint.showOutput", () => {
      output.show(true);
    }),
    vscode.commands.registerCommand(
      "bunLint.explainRule",
      async (rule: string) => {
        const document = await vscode.workspace.openTextDocument(
          explainUri(rule),
        );
        await vscode.window.showTextDocument(document, {
          preview: true,
          viewColumn: vscode.ViewColumn.Beside,
        });
      },
    ),
    {
      dispose: () => {
        for (const c of running.values()) c.abort();
        for (const t of timers.values()) clearTimeout(t);
      },
    },
  );

  lintAllOpen();
}

/** Stops the extension; everything is in `context.subscriptions`. */
export function deactivate(): void {}
