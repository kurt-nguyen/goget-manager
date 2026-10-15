/**
 * Per-workspace-folder go.mod state: reads, parsing, file watching, debounce,
 * and stale-result protection.
 *
 * The class depends only on the small interfaces below so unit tests can fake
 * every host API. `createDefaultDeps` builds the real `vscode`-backed versions.
 */

import * as vscode from 'vscode';
import { KeyedDebouncer } from '../core/debouncer';
import { parseGoMod } from '../core/goModParser';
import type { FolderGoModState, InstalledSnapshot } from '../core/installedModel';

/** The slice of `vscode.Uri` the repository needs. */
export interface UriLike {
  readonly fsPath: string;
  toString(): string;
}

/** The slice of `vscode.WorkspaceFolder` the repository needs. */
export interface WorkspaceFolderLike {
  readonly uri: UriLike;
  readonly name: string;
}

/** Resolves and reads a folder's root go.mod. */
export interface FileReader {
  /** The URI of `<folder>/go.mod`. */
  goModUri(folder: WorkspaceFolderLike): UriLike;
  /** Rejects with a `FileSystemError` (code `FileNotFound`) when the file does not exist. */
  readFile(uri: UriLike): PromiseLike<Uint8Array>;
}

/** The slice of `vscode.OutputChannel` the repository needs. */
export interface OutputLike {
  appendLine(value: string): void;
}

export interface DisposableLike {
  dispose(): void;
}

/** A watcher on one folder's root go.mod. Mirrors `vscode.FileSystemWatcher`. */
export interface GoModWatcher extends DisposableLike {
  onDidCreate(listener: () => void): DisposableLike;
  onDidChange(listener: () => void): DisposableLike;
  onDidDelete(listener: () => void): DisposableLike;
}

export type WatcherFactory = (folder: WorkspaceFolderLike) => GoModWatcher;

export interface WorkspaceFoldersChange {
  readonly added: readonly WorkspaceFolderLike[];
  readonly removed: readonly WorkspaceFolderLike[];
}

/** Source of the open workspace folders and their change event. */
export interface WorkspaceFoldersSource {
  /** Current folders in workspace order. Must already reflect a change when its event fires. */
  getFolders(): readonly WorkspaceFolderLike[];
  onDidChangeWorkspaceFolders(listener: (e: WorkspaceFoldersChange) => void): DisposableLike;
}

export interface GoModRepositoryDeps {
  readonly fs: FileReader;
  readonly output: OutputLike;
  readonly watchers: WatcherFactory;
  readonly workspace: WorkspaceFoldersSource;
  /** Debounce window for watcher events. Default 300. */
  readonly debounceMs?: number;
  /** Clock for output timestamps. Default `() => new Date()`. */
  readonly now?: () => Date;
}

interface FolderEntry {
  readonly folder: WorkspaceFolderLike;
  readonly key: string;
  readonly watcher: GoModWatcher;
  readonly subscriptions: readonly DisposableLike[];
  generation: number;
  state: FolderGoModState;
}

const DEFAULT_DEBOUNCE_MS = 300;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isFileNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const { code, name } = err as { code?: unknown; name?: unknown };
  return (
    code === 'FileNotFound' ||
    code === 'ENOENT' ||
    (typeof name === 'string' && /EntryNotFound|FileNotFound/.test(name))
  );
}

export class GoModRepository implements DisposableLike {
  private readonly entries = new Map<string, FolderEntry>();
  private readonly listeners = new Set<() => void>();
  private readonly debouncer: KeyedDebouncer<string>;
  private readonly now: () => Date;
  private folderSubscription: DisposableLike | undefined;
  private initialized = false;
  private disposed = false;

  /** Fires after any change to the snapshot. */
  readonly onDidChange: vscode.Event<void> = (listener, thisArgs, disposables) => {
    const wrapped = (): void => {
      listener.call(thisArgs);
    };
    this.listeners.add(wrapped);
    const subscription: DisposableLike = {
      dispose: () => {
        this.listeners.delete(wrapped);
      },
    };
    disposables?.push(subscription);
    return subscription;
  };

  constructor(private readonly deps: GoModRepositoryDeps) {
    this.debouncer = new KeyedDebouncer<string>(deps.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    this.now = deps.now ?? (() => new Date());
  }

  /** Creates entries and watchers for the open folders, loads them all, and tracks folder changes. */
  async initialize(): Promise<void> {
    if (this.initialized || this.disposed) {
      return;
    }
    this.initialized = true;

    this.folderSubscription = this.deps.workspace.onDidChangeWorkspaceFolders((e) => {
      this.handleFoldersChanged(e);
    });

    const folders = this.deps.workspace.getFolders();
    for (const folder of folders) {
      this.addFolder(folder);
    }
    await Promise.all(folders.map((folder) => this.load(folder)));
  }

  /** Cancels pending debounces and re-reads every folder now, in parallel. */
  async refreshAll(): Promise<void> {
    for (const key of this.entries.keys()) {
      this.debouncer.cancel(key);
    }
    const folders = [...this.entries.values()].map((entry) => entry.folder);
    await Promise.all(folders.map((folder) => this.load(folder)));
  }

  /** Current state of every tracked folder, in workspace order. */
  snapshot(): InstalledSnapshot {
    const folders: FolderGoModState[] = [];
    for (const folder of this.deps.workspace.getFolders()) {
      const entry = this.entries.get(folder.uri.toString());
      if (entry !== undefined) {
        folders.push(entry.state);
      }
    }
    return { folders };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.folderSubscription?.dispose();
    this.folderSubscription = undefined;
    this.debouncer.dispose();
    for (const entry of this.entries.values()) {
      this.disposeEntry(entry);
    }
    this.entries.clear();
    this.listeners.clear();
  }

  private handleFoldersChanged(e: WorkspaceFoldersChange): void {
    if (this.disposed) {
      return;
    }
    let removedAny = false;
    for (const folder of e.removed) {
      const entry = this.entries.get(folder.uri.toString());
      if (entry !== undefined) {
        this.entries.delete(entry.key);
        this.debouncer.cancel(entry.key);
        this.disposeEntry(entry);
        removedAny = true;
      }
    }
    const added: WorkspaceFolderLike[] = [];
    for (const folder of e.added) {
      if (!this.entries.has(folder.uri.toString())) {
        this.addFolder(folder);
        added.push(folder);
      }
    }
    if (removedAny) {
      this.fireChange();
    }
    for (const folder of added) {
      void this.load(folder);
    }
  }

  private addFolder(folder: WorkspaceFolderLike): void {
    const key = folder.uri.toString();
    const schedule = (): void => {
      this.debouncer.schedule(key, () => {
        void this.load(folder);
      });
    };
    const watcher = this.deps.watchers(folder);
    const entry: FolderEntry = {
      folder,
      key,
      watcher,
      subscriptions: [watcher.onDidCreate(schedule), watcher.onDidChange(schedule), watcher.onDidDelete(schedule)],
      generation: 0,
      state: { kind: 'absent', folderUri: key, folderName: folder.name },
    };
    this.entries.set(key, entry);
  }

  private disposeEntry(entry: FolderEntry): void {
    for (const subscription of entry.subscriptions) {
      subscription.dispose();
    }
    entry.watcher.dispose();
  }

  /** Reads and parses the folder's go.mod. Never rejects. */
  private async load(folder: WorkspaceFolderLike): Promise<void> {
    const key = folder.uri.toString();
    const entry = this.entries.get(key);
    if (entry === undefined || this.disposed) {
      return;
    }
    const generation = ++entry.generation;
    const goModUri = this.deps.fs.goModUri(folder);
    const goModPath = goModUri.fsPath;
    const base = { folderUri: key, folderName: folder.name } as const;

    let state: FolderGoModState;
    try {
      let bytes: Uint8Array | undefined;
      try {
        bytes = await this.deps.fs.readFile(goModUri);
      } catch (err) {
        if (isFileNotFound(err)) {
          state = { kind: 'absent', ...base };
        } else {
          const reason = errorMessage(err);
          this.log(`Failed to read ${goModPath}: ${reason}`);
          state = { kind: 'readError', ...base, goModPath, reason };
        }
      }
      if (bytes !== undefined) {
        const result = parseGoMod(new TextDecoder('utf-8').decode(bytes));
        state = result.ok
          ? {
              kind: 'parsed',
              ...base,
              goModPath,
              ...(result.modulePath !== undefined ? { modulePath: result.modulePath } : {}),
              dependencies: result.dependencies,
            }
          : { kind: 'parseError', ...base, goModPath, error: result.error };
      }
    } catch (err) {
      this.log(`Unexpected error while loading ${goModPath}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      state = { kind: 'readError', ...base, goModPath, reason: errorMessage(err) };
    }

    // Drop results from superseded loads and for folders that were removed meanwhile.
    if (this.disposed || this.entries.get(key) !== entry || entry.generation !== generation) {
      return;
    }
    // `state` is always assigned: every path above either assigns it or throws into the catch.
    entry.state = state!;
    this.fireChange();
  }

  private fireChange(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (err) {
        this.log(`Listener failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      }
    }
  }

  private log(message: string): void {
    this.deps.output.appendLine(`[${this.now().toISOString()}] ${message}`);
  }
}

/** Builds the real `vscode`-backed dependencies. */
export function createDefaultDeps(output: vscode.OutputChannel, debounceMs?: number): GoModRepositoryDeps {
  return {
    fs: {
      goModUri: (folder) => vscode.Uri.joinPath(folder.uri as vscode.Uri, 'go.mod'),
      readFile: (uri) => vscode.workspace.fs.readFile(uri as vscode.Uri),
    },
    output,
    watchers: (folder) =>
      vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder as vscode.WorkspaceFolder, 'go.mod')),
    workspace: {
      getFolders: () => vscode.workspace.workspaceFolders ?? [],
      onDidChangeWorkspaceFolders: (listener) => vscode.workspace.onDidChangeWorkspaceFolders(listener),
    },
    ...(debounceMs !== undefined ? { debounceMs } : {}),
  };
}
