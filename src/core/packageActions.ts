import { isValidImportPath } from './detailUrl';
import type { InstalledSnapshot } from './installedModel';
import { findInstalledModule, isInstallablePath } from './installedMatch';
import {
  GO_NOT_FOUND,
  NOT_INSTALLABLE,
  NO_GO_MOD_FOR_INSTALL,
  PICK_FOLDER_INSTALL,
  actionResultLog,
  actionStartLog,
  goFailed,
  goTimedOut,
  notRequired,
  pickFolderUninstall,
  type PackageAction,
} from './messages';
import type { OutputLike } from './searchController';

export type GoRunResult =
  | { readonly ok: true; readonly output: string }
  | { readonly ok: false; readonly reason: 'notFound' | 'timeout' | 'failed'; readonly output: string };

export interface GoRunner {
  run(cwd: string, args: readonly string[]): Promise<GoRunResult>;
}

export interface ActionCandidate {
  readonly label: string;
  readonly goModPath: string;
  readonly module?: string;
}

export type ActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly cancelled: true }
  | { readonly ok: false; readonly cancelled?: false; readonly error: string };

export interface PackageActionsDeps {
  readonly snapshot: () => InstalledSnapshot;
  readonly run: GoRunner['run'];
  readonly pickFolder: (candidates: readonly ActionCandidate[], placeholder: string) => Promise<ActionCandidate | undefined>;
  /** Reloads go.mod state so every view follows the change. */
  readonly refresh: () => Promise<void>;
  readonly dirname: (goModPath: string) => string;
  readonly output: OutputLike;
  /** Clock for output timestamps. Default `() => new Date()`. */
  readonly now?: () => Date;
}

const MAX_DETAIL_LENGTH = 300;

function errorText(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

/** Last non-empty line of Go's output, capped, for the inline message. */
function lastLine(output: string): string {
  const lines = output.split(/\r?\n/).filter((line) => line.trim() !== '');
  return (lines[lines.length - 1] ?? '').trim().slice(0, MAX_DETAIL_LENGTH);
}

/**
 * Installs and uninstalls packages by running Go in a workspace folder. Runs one
 * Go command at a time and never rejects. The installed state is not tracked
 * here: after a command it reloads go.mod, which every view reads.
 */
export class PackageActions {
  private readonly now: () => Date;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: PackageActionsDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  install(path: string): Promise<ActionResult> {
    return this.enqueue('install', path, () => this.doInstall(path));
  }

  uninstall(path: string): Promise<ActionResult> {
    return this.enqueue('uninstall', path, () => this.doUninstall(path));
  }

  private enqueue(action: PackageAction, path: string, task: () => Promise<ActionResult>): Promise<ActionResult> {
    const result = this.tail.then(task).catch((err: unknown): ActionResult => {
      this.write(actionResultLog(this.now().toISOString(), action, path, `unexpected error: ${errorText(err)}`, ''));
      return { ok: false, error: goFailed(action, err instanceof Error ? err.message : String(err)) };
    });
    this.tail = result;
    return result;
  }

  private async doInstall(path: string): Promise<ActionResult> {
    if (!isInstallablePath(path) || !isValidImportPath(path)) {
      return { ok: false, error: NOT_INSTALLABLE };
    }
    const candidates: ActionCandidate[] = [];
    for (const folder of this.deps.snapshot().folders) {
      if (folder.kind === 'parsed') {
        candidates.push({ label: folder.modulePath ?? folder.folderName, goModPath: folder.goModPath });
      }
    }
    if (candidates.length === 0) {
      return { ok: false, error: NO_GO_MOD_FOR_INSTALL };
    }
    const target = await this.choose(candidates, PICK_FOLDER_INSTALL);
    if (target === undefined) {
      return { ok: false, cancelled: true };
    }
    return this.runGo('install', path, target, ['get', '--', path]);
  }

  private async doUninstall(path: string): Promise<ActionResult> {
    const candidates: ActionCandidate[] = [];
    for (const folder of this.deps.snapshot().folders) {
      if (folder.kind !== 'parsed') {
        continue;
      }
      const module = findInstalledModule(path, new Set(folder.dependencies.map((dep) => dep.path)));
      if (module !== undefined) {
        candidates.push({ label: folder.modulePath ?? folder.folderName, goModPath: folder.goModPath, module });
      }
    }
    if (candidates.length === 0) {
      return { ok: false, error: notRequired(path) };
    }
    const target = await this.choose(candidates, pickFolderUninstall(path));
    if (target?.module === undefined) {
      return { ok: false, cancelled: true };
    }
    return this.runGo('uninstall', path, target, ['mod', 'edit', `-droprequire=${target.module}`]);
  }

  private async choose(candidates: readonly ActionCandidate[], placeholder: string): Promise<ActionCandidate | undefined> {
    return candidates.length === 1 ? candidates[0] : this.deps.pickFolder(candidates, placeholder);
  }

  private async runGo(
    action: PackageAction,
    path: string,
    target: ActionCandidate,
    args: readonly string[],
  ): Promise<ActionResult> {
    const cwd = this.deps.dirname(target.goModPath);
    this.write(actionStartLog(this.now().toISOString(), action, path, cwd, args));
    const result = await this.deps.run(cwd, args);
    try {
      await this.deps.refresh();
    } catch (err) {
      this.write(`[${this.now().toISOString()}] Reloading go.mod failed: ${errorText(err)}`);
    }
    if (result.ok) {
      this.write(actionResultLog(this.now().toISOString(), action, path, 'done', result.output));
      return { ok: true };
    }
    const error =
      result.reason === 'notFound'
        ? GO_NOT_FOUND
        : result.reason === 'timeout'
          ? goTimedOut(action)
          : goFailed(action, lastLine(result.output) || 'Go reported an error.');
    this.write(actionResultLog(this.now().toISOString(), action, path, `failed (${result.reason})`, result.output));
    return { ok: false, error };
  }

  private write(text: string): void {
    try {
      this.deps.output.appendLine(text);
    } catch {
      // Logging must never break an action.
    }
  }
}
