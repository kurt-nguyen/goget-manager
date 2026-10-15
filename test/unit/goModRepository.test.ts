import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GoModRepository,
  type DisposableLike,
  type FileReader,
  type GoModWatcher,
  type UriLike,
  type WorkspaceFolderLike,
  type WorkspaceFoldersChange,
  type WorkspaceFoldersSource,
} from '../../src/vscode/goModRepository';
import { FileSystemError, Uri } from './vscodeStub';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

function makeFolder(name: string): WorkspaceFolderLike {
  return { uri: Uri.file(`/ws/${name}`), name };
}

interface Deferred {
  resolve(bytes: Uint8Array): void;
  reject(err: unknown): void;
}

/** Fake file system. Each folder's go.mod is a value, an error, or a manually settled read. */
class FakeFs implements FileReader {
  readonly reads: string[] = [];
  private readonly files = new Map<string, Uint8Array | Error>();
  private readonly held: Array<{ path: string; deferred: Deferred }> = [];
  private holdNext = false;

  goModUri(folder: WorkspaceFolderLike): UriLike {
    return Uri.file(`${folder.uri.fsPath}/go.mod`);
  }

  set(folder: WorkspaceFolderLike, content: string | Error): void {
    this.files.set(this.goModUri(folder).fsPath, typeof content === 'string' ? enc(content) : content);
  }

  /** The next read stays pending until settled through `held`. */
  holdNextRead(): void {
    this.holdNext = true;
  }

  get pendingReads(): number {
    return this.held.length;
  }

  settle(index: number, content: string): void {
    this.held[index]!.deferred.resolve(enc(content));
  }

  readFile(uri: UriLike): PromiseLike<Uint8Array> {
    this.reads.push(uri.fsPath);
    if (this.holdNext) {
      this.holdNext = false;
      return new Promise<Uint8Array>((resolve, reject) => {
        this.held.push({ path: uri.fsPath, deferred: { resolve, reject } });
      });
    }
    const entry = this.files.get(uri.fsPath);
    if (entry === undefined) {
      return Promise.reject(FileSystemError.FileNotFound(uri.fsPath));
    }
    return entry instanceof Error ? Promise.reject(entry) : Promise.resolve(entry);
  }
}

class FakeWatcher implements GoModWatcher {
  disposed = false;
  private readonly handlers = { create: [] as Array<() => void>, change: [] as Array<() => void>, delete: [] as Array<() => void> };

  private on(list: Array<() => void>, listener: () => void): DisposableLike {
    list.push(listener);
    return { dispose: () => void list.splice(list.indexOf(listener), 1) };
  }

  onDidCreate(listener: () => void): DisposableLike {
    return this.on(this.handlers.create, listener);
  }
  onDidChange(listener: () => void): DisposableLike {
    return this.on(this.handlers.change, listener);
  }
  onDidDelete(listener: () => void): DisposableLike {
    return this.on(this.handlers.delete, listener);
  }
  dispose(): void {
    this.disposed = true;
  }

  fire(kind: 'create' | 'change' | 'delete'): void {
    for (const l of [...this.handlers[kind]]) {
      l();
    }
  }
}

class FakeWorkspace implements WorkspaceFoldersSource {
  folders: WorkspaceFolderLike[];
  private listeners: Array<(e: WorkspaceFoldersChange) => void> = [];

  constructor(folders: WorkspaceFolderLike[]) {
    this.folders = folders;
  }

  getFolders(): readonly WorkspaceFolderLike[] {
    return this.folders;
  }

  onDidChangeWorkspaceFolders(listener: (e: WorkspaceFoldersChange) => void): DisposableLike {
    this.listeners.push(listener);
    return { dispose: () => void (this.listeners = this.listeners.filter((l) => l !== listener)) };
  }

  /** Mirrors VS Code: `getFolders()` already reflects the change when the event fires. */
  change(added: WorkspaceFolderLike[], removed: WorkspaceFolderLike[]): void {
    this.folders = [...this.folders.filter((f) => !removed.includes(f)), ...added];
    for (const l of [...this.listeners]) {
      l({ added, removed });
    }
  }
}

const DEBOUNCE = 300;
const NOW = new Date('2024-01-02T03:04:05.000Z');

interface Harness {
  repo: GoModRepository;
  fs: FakeFs;
  ws: FakeWorkspace;
  lines: string[];
  watchers: Map<string, FakeWatcher>;
  changes: { count: number };
}

function setup(folders: WorkspaceFolderLike[]): Harness {
  const fs = new FakeFs();
  const ws = new FakeWorkspace(folders);
  const lines: string[] = [];
  const watchers = new Map<string, FakeWatcher>();
  const repo = new GoModRepository({
    fs,
    output: { appendLine: (v) => void lines.push(v) },
    watchers: (folder) => {
      const w = new FakeWatcher();
      watchers.set(folder.uri.toString(), w);
      return w;
    },
    workspace: ws,
    debounceMs: DEBOUNCE,
    now: () => NOW,
  });
  const changes = { count: 0 };
  repo.onDidChange(() => {
    changes.count++;
  });
  return { repo, fs, ws, lines, watchers, changes };
}

const MOD_A = 'module example.com/a\n\ngo 1.21\n\nrequire github.com/foo/bar v1.0.0\n';
const MOD_B = 'module example.com/b\n\ngo 1.21\n\nrequire github.com/baz/qux v2.0.0\n';

/** Lets promise continuations run (fake timers do not touch microtasks). */
const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GoModRepository', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads every folder on initialize', async () => {
    const a = makeFolder('a');
    const b = makeFolder('b');
    const h = setup([a, b]);
    h.fs.set(a, MOD_A);
    // b has no go.mod
    await h.repo.initialize();

    const { folders } = h.repo.snapshot();
    expect(folders).toHaveLength(2);
    expect(folders[0]).toMatchObject({
      kind: 'parsed',
      folderName: 'a',
      modulePath: 'example.com/a',
      dependencies: [{ path: 'github.com/foo/bar', version: 'v1.0.0' }],
    });
    expect(folders[1]).toMatchObject({ kind: 'absent', folderName: 'b' });
    expect(h.watchers.size).toBe(2);
  });

  it('adds and loads a folder when one is added', async () => {
    const a = makeFolder('a');
    const b = makeFolder('b');
    const h = setup([a]);
    h.fs.set(a, MOD_A);
    h.fs.set(b, MOD_B);
    await h.repo.initialize();
    h.changes.count = 0;

    h.ws.change([b], []);
    await flush();

    const { folders } = h.repo.snapshot();
    expect(folders.map((f) => f.folderName)).toEqual(['a', 'b']);
    expect(folders[1]).toMatchObject({ kind: 'parsed', modulePath: 'example.com/b' });
    expect(h.watchers.has(b.uri.toString())).toBe(true);
    expect(h.changes.count).toBeGreaterThan(0);
  });

  it('removes a folder: disposes its watcher, drops it from the snapshot, and fires a change', async () => {
    const a = makeFolder('a');
    const b = makeFolder('b');
    const h = setup([a, b]);
    h.fs.set(a, MOD_A);
    h.fs.set(b, MOD_B);
    await h.repo.initialize();
    h.changes.count = 0;
    const watcherB = h.watchers.get(b.uri.toString())!;

    h.ws.change([], [b]);

    expect(watcherB.disposed).toBe(true);
    expect(h.repo.snapshot().folders.map((f) => f.folderName)).toEqual(['a']);
    expect(h.changes.count).toBe(1);

    // Events from the removed folder's watcher no longer cause reads.
    const readsBefore = h.fs.reads.length;
    watcherB.fire('change');
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 2);
    expect(h.fs.reads.length).toBe(readsBefore);
  });

  it('discards a pending read for a folder removed meanwhile', async () => {
    const a = makeFolder('a');
    const h = setup([a]);
    h.fs.holdNextRead();
    const init = h.repo.initialize();
    await flush();
    expect(h.fs.pendingReads).toBe(1);

    h.ws.change([], [a]);
    h.fs.settle(0, MOD_A);
    await init;

    expect(h.repo.snapshot().folders).toEqual([]);
  });

  it('refreshAll re-reads every folder', async () => {
    const a = makeFolder('a');
    const b = makeFolder('b');
    const h = setup([a, b]);
    h.fs.set(a, MOD_A);
    h.fs.set(b, MOD_B);
    await h.repo.initialize();
    expect(h.fs.reads).toHaveLength(2);

    h.fs.set(a, 'module example.com/a2\n');
    await h.repo.refreshAll();

    expect(h.fs.reads).toHaveLength(4);
    expect(h.repo.snapshot().folders[0]).toMatchObject({ kind: 'parsed', modulePath: 'example.com/a2' });
  });

  it('refreshAll cancels pending debounces so the burst does not read again', async () => {
    const a = makeFolder('a');
    const h = setup([a]);
    h.fs.set(a, MOD_A);
    await h.repo.initialize();
    const baseline = h.fs.reads.length;

    h.watchers.get(a.uri.toString())!.fire('change');
    await vi.advanceTimersByTimeAsync(DEBOUNCE / 2);
    await h.repo.refreshAll();
    expect(h.fs.reads.length).toBe(baseline + 1);

    await vi.advanceTimersByTimeAsync(DEBOUNCE * 2);
    expect(h.fs.reads.length).toBe(baseline + 1);
  });

  it('treats FileNotFound as absent without logging', async () => {
    const a = makeFolder('a');
    const h = setup([a]);
    await h.repo.initialize();

    expect(h.repo.snapshot().folders[0]).toMatchObject({ kind: 'absent', folderName: 'a' });
    expect(h.lines).toEqual([]);
  });

  it('treats ENOENT code as absent', async () => {
    const a = makeFolder('a');
    const h = setup([a]);
    h.fs.set(a, Object.assign(new Error('no such file'), { code: 'ENOENT' }));
    await h.repo.initialize();

    expect(h.repo.snapshot().folders[0]!.kind).toBe('absent');
  });

  it('maps other read errors to readError and logs a timestamped output line', async () => {
    const a = makeFolder('a');
    const h = setup([a]);
    h.fs.set(a, FileSystemError.NoPermissions('permission denied'));
    await h.repo.initialize();

    const state = h.repo.snapshot().folders[0]!;
    expect(state).toMatchObject({ kind: 'readError', reason: 'permission denied', goModPath: '/ws/a/go.mod' });
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toContain('[2024-01-02T03:04:05.000Z]');
    expect(h.lines[0]).toContain('/ws/a/go.mod');
    expect(h.lines[0]).toContain('permission denied');
  });

  it('recovers from readError to parsed after a watcher event', async () => {
    const a = makeFolder('a');
    const h = setup([a]);
    h.fs.set(a, FileSystemError.NoPermissions('permission denied'));
    await h.repo.initialize();
    expect(h.repo.snapshot().folders[0]!.kind).toBe('readError');

    h.fs.set(a, MOD_A);
    h.watchers.get(a.uri.toString())!.fire('change');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(h.repo.snapshot().folders[0]).toMatchObject({ kind: 'parsed', modulePath: 'example.com/a' });
  });

  it('reports a parseError for malformed go.mod', async () => {
    const a = makeFolder('a');
    const h = setup([a]);
    h.fs.set(a, 'require (\n  github.com/foo/bar v1.0.0\n');
    await h.repo.initialize();

    expect(h.repo.snapshot().folders[0]!.kind).toBe('parseError');
  });

  it('discards a stale read superseded by a newer load (generation counter)', async () => {
    const a = makeFolder('a');
    const h = setup([a]);
    h.fs.set(a, MOD_A);
    await h.repo.initialize();

    // First reload hangs; second reload completes with newer content.
    h.fs.holdNextRead();
    const slow = h.repo.refreshAll();
    await flush();
    expect(h.fs.pendingReads).toBe(1);

    h.fs.set(a, 'module example.com/new\n');
    await h.repo.refreshAll();
    expect(h.repo.snapshot().folders[0]).toMatchObject({ modulePath: 'example.com/new' });

    // The older read now finishes with stale content and must be ignored.
    const changesBefore = h.changes.count;
    h.fs.settle(0, 'module example.com/old\n');
    await slow;

    expect(h.repo.snapshot().folders[0]).toMatchObject({ modulePath: 'example.com/new' });
    expect(h.changes.count).toBe(changesBefore);
  });

  it('collapses a burst of watcher events into one load', async () => {
    const a = makeFolder('a');
    const h = setup([a]);
    h.fs.set(a, MOD_A);
    await h.repo.initialize();
    const baseline = h.fs.reads.length;
    const watcher = h.watchers.get(a.uri.toString())!;

    for (let i = 0; i < 5; i++) {
      watcher.fire(i % 2 === 0 ? 'change' : 'create');
      await vi.advanceTimersByTimeAsync(DEBOUNCE / 3);
    }
    watcher.fire('delete');
    expect(h.fs.reads.length).toBe(baseline);

    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(h.fs.reads.length).toBe(baseline + 1);
  });

  it('stops reacting after dispose', async () => {
    const a = makeFolder('a');
    const h = setup([a]);
    h.fs.set(a, MOD_A);
    await h.repo.initialize();
    const watcher = h.watchers.get(a.uri.toString())!;
    const baseline = h.fs.reads.length;

    watcher.fire('change');
    h.repo.dispose();
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 2);

    expect(watcher.disposed).toBe(true);
    expect(h.fs.reads.length).toBe(baseline);
  });
});
