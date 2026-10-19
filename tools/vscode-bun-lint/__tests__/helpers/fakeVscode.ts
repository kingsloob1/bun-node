/**
 * The part of the `vscode` API the extension uses, as plain objects, so
 * `extension.ts` can be activated under `bun test` (with `mock.module`) and
 * its providers called with real `bun lint` / `bun fmt` behind them. It
 * records what the extension registered and set, for the assertions.
 */
import { pathToFileURL } from "node:url";

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}

export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(
    a: number | Position,
    b: number | Position,
    c?: number,
    d?: number,
  ) {
    if (typeof a === "number" && typeof b === "number") {
      this.start = new Position(a, b);
      this.end = new Position(c ?? a, d ?? b);
    } else {
      this.start = a as Position;
      this.end = b as Position;
    }
  }
}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

export class Diagnostic {
  source?: string;
  code?: string | number | { value: string | number; target: Uri };
  constructor(
    readonly range: Range,
    readonly message: string,
    readonly severity: DiagnosticSeverity,
  ) {}
}

export class Uri {
  constructor(
    readonly scheme: string,
    readonly path: string,
    readonly fsPath: string,
  ) {}

  static file(path: string): Uri {
    return new Uri("file", path, path);
  }

  static from(parts: { scheme: string; path: string }): Uri {
    return new Uri(parts.scheme, parts.path, parts.path);
  }

  toString(): string {
    return this.scheme === "file"
      ? pathToFileURL(this.fsPath).href
      : `${this.scheme}:${this.path}`;
  }
}

export class CodeActionKind {
  static readonly QuickFix = new CodeActionKind("quickfix");
  static readonly Source = new CodeActionKind("source");
  static readonly SourceFixAll = new CodeActionKind("source.fixAll");
  constructor(readonly value: string) {}
  append(part: string): CodeActionKind {
    return new CodeActionKind(`${this.value}.${part}`);
  }

  contains(other: CodeActionKind): boolean {
    return (
      other.value === this.value || other.value.startsWith(`${this.value}.`)
    );
  }
}

export class WorkspaceEdit {
  readonly edits: { uri: Uri; range: Range; text: string }[] = [];
  replace(uri: Uri, range: Range, text: string): void {
    this.edits.push({ uri, range, text });
  }
}

export class TextEdit {
  constructor(
    readonly range: Range,
    readonly newText: string,
  ) {}

  static replace(range: Range, text: string): TextEdit {
    return new TextEdit(range, text);
  }
}

export class CodeAction {
  edit?: WorkspaceEdit;
  command?: { title: string; command: string; arguments?: unknown[] };
  diagnostics?: Diagnostic[];
  isPreferred?: boolean;
  constructor(
    readonly title: string,
    readonly kind: CodeActionKind,
  ) {}
}

export enum ViewColumn {
  Beside = -2,
}

/** A text document over a string, with VS Code's offset/position maths (UTF-16). */
export class FakeDocument {
  version = 1;
  isClosed = false;
  readonly uri: Uri;
  constructor(
    readonly fileName: string,
    public text: string,
    readonly languageId: string,
  ) {
    this.uri = Uri.file(fileName);
  }

  getText(): string {
    return this.text;
  }

  positionAt(offset: number): Position {
    const before = this.text.slice(
      0,
      Math.max(0, Math.min(offset, this.text.length)),
    );
    const lines = before.split("\n");
    return new Position(lines.length - 1, lines.at(-1)!.length);
  }

  offsetAt(p: Position): number {
    const lines = this.text.split("\n");
    let offset = 0;
    for (let i = 0; i < p.line && i < lines.length; i++)
      offset += lines[i].length + 1;
    return offset + p.character;
  }

  /**
   * Applies edits as VS Code would, last first, so offsets stay valid.
   * @param edits The edits, by range.
   */
  apply(edits: { range: Range; text: string }[]): void {
    const byOffset = edits
      .map((e) => ({
        start: this.offsetAt(e.range.start),
        end: this.offsetAt(e.range.end),
        text: e.text,
      }))
      .sort((a, b) => b.start - a.start);
    for (const e of byOffset)
      this.text = this.text.slice(0, e.start) + e.text + this.text.slice(e.end);
    this.version++;
  }
}

type Listener<T> = (value: T) => unknown;

/** Builds a fresh fake `vscode` module and the record of what it saw. */
export function createFakeVscode(options: {
  documents: FakeDocument[];
  config?: Record<string, unknown>;
  workspace: string;
}) {
  const record = {
    commands: new Map<string, (...args: unknown[]) => unknown>(),
    diagnostics: new Map<string, Diagnostic[]>(),
    codeActionProviders: [] as {
      selector: { language: string }[];
      provider: {
        provideCodeActions: (...a: unknown[]) => Promise<CodeAction[]>;
      };
    }[],
    formatProviders: [] as {
      selector: { language: string }[];
      provider: {
        provideDocumentFormattingEdits: (
          ...a: unknown[]
        ) => Promise<TextEdit[]>;
      };
    }[],
    rangeFormatProviders: [] as {
      selector: { language: string }[];
      provider: {
        provideDocumentRangeFormattingEdits: (
          ...a: unknown[]
        ) => Promise<TextEdit[]>;
      };
    }[],
    contentProviders: new Map<
      string,
      { provideTextDocumentContent: (uri: Uri) => Promise<string> }
    >(),
    errors: [] as string[],
    output: [] as string[],
    listeners: {
      open: [] as Listener<FakeDocument>[],
      save: [] as Listener<FakeDocument>[],
      change: [] as Listener<{
        document: FakeDocument;
        contentChanges: unknown[];
      }>[],
      close: [] as Listener<FakeDocument>[],
      config: [] as Listener<{
        affectsConfiguration: (s: string) => boolean;
      }>[],
    },
    subscriptions: [] as { dispose: () => unknown }[],
  };
  const config: Record<string, unknown> = { ...options.config };
  const disposable = { dispose: () => {} };
  const event =
    <T>(list: Listener<T>[]) =>
    (fn: Listener<T>) => {
      list.push(fn);
      return disposable;
    };
  const collection = {
    set: (uri: Uri, ds: Diagnostic[]) =>
      record.diagnostics.set(uri.toString(), ds),
    delete: (uri: Uri) => record.diagnostics.delete(uri.toString()),
    has: (uri: Uri) => record.diagnostics.has(uri.toString()),
    dispose: () => {},
  };
  const vscode = {
    Position,
    Range,
    Diagnostic,
    DiagnosticSeverity,
    Uri,
    CodeActionKind,
    CodeAction,
    WorkspaceEdit,
    TextEdit,
    ViewColumn,
    window: {
      createOutputChannel: () => ({
        appendLine: (l: string) => record.output.push(l),
        show: () => {},
        dispose: () => {},
      }),
      showErrorMessage: (m: string) => {
        record.errors.push(m);
        return Promise.resolve(undefined);
      },
      setStatusBarMessage: () => disposable,
      activeTextEditor: options.documents[0]
        ? { document: options.documents[0] }
        : undefined,
      showTextDocument: () => Promise.resolve(undefined),
    },
    languages: {
      createDiagnosticCollection: () => collection,
      registerCodeActionsProvider: (
        selector: { language: string }[],
        provider: never,
      ) => {
        record.codeActionProviders.push({ selector, provider });
        return disposable;
      },
      registerDocumentFormattingEditProvider: (
        selector: { language: string }[],
        provider: never,
      ) => {
        record.formatProviders.push({ selector, provider });
        return disposable;
      },
      registerDocumentRangeFormattingEditProvider: (
        selector: { language: string }[],
        provider: never,
      ) => {
        record.rangeFormatProviders.push({ selector, provider });
        return disposable;
      },
    },
    workspace: {
      getConfiguration: () => ({
        get: <T>(key: string, fallback: T): T =>
          key in config ? (config[key] as T) : fallback,
      }),
      workspaceFolders: [{ uri: Uri.file(options.workspace) }],
      textDocuments: options.documents,
      asRelativePath: (uri: Uri) => uri.fsPath,
      applyEdit: (edit: WorkspaceEdit) => {
        for (const doc of options.documents)
          doc.apply(
            edit.edits.filter((e) => e.uri.toString() === doc.uri.toString()),
          );
        return Promise.resolve(true);
      },
      openTextDocument: () => Promise.resolve(undefined),
      registerTextDocumentContentProvider: (
        scheme: string,
        provider: never,
      ) => {
        record.contentProviders.set(scheme, provider);
        return disposable;
      },
      onDidOpenTextDocument: event(record.listeners.open),
      onDidSaveTextDocument: event(record.listeners.save),
      onDidChangeTextDocument: event(record.listeners.change),
      onDidCloseTextDocument: event(record.listeners.close),
      onDidChangeConfiguration: event(record.listeners.config),
    },
    commands: {
      registerCommand: (id: string, fn: (...args: unknown[]) => unknown) => {
        record.commands.set(id, fn);
        return disposable;
      },
    },
  };
  return { vscode, record, config };
}

/** A cancellation token that is never cancelled. */
export const neverCancelled = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => {} }),
};

/**
 * Waits until `ready()` holds, checking every 20 ms, up to `ms`.
 * @param ready The condition.
 * @param ms The budget.
 */
export async function until(ready: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(20);
  }
}
