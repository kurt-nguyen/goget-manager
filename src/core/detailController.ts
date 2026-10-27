import { defaultTimerApi, type TimerApi } from './debouncer';
import { EMPTY_DETAIL_STATE, type DetailViewModel, type HostToDetail } from './detailProtocol';
import { packageDetailUrl, isValidImportPath } from './detailUrl';
import {
  DETAIL_BAD_PAGE,
  DETAIL_INVALID_PATH,
  DETAIL_NOT_FOUND,
  DETAIL_TIMED_OUT,
  UNREACHABLE,
  detailFailureLog,
  httpError,
  installStubLog,
} from './messages';
import { parsePackageDetail } from './packageDetail';
import type { DisposableLike, OutputLike, SearchClient, SearchFailure, SearchResponse } from './searchController';

export interface DetailControllerDeps {
  readonly client: SearchClient;
  readonly output: OutputLike;
  readonly isInstalled: (path: string) => boolean;
  /** Timers for the request timeout. Default: global timers. */
  readonly timers?: TimerApi;
  /** Clock for output timestamps. Default `() => new Date()`. */
  readonly now?: () => Date;
  /** Request timeout. Default 20_000. */
  readonly timeoutMs?: number;
}

type DetailOutcome = SearchResponse | { readonly kind: 'timeout' };

interface InFlight {
  readonly generation: number;
  readonly path: string;
  readonly goos: string | undefined;
  /** `page` replaces the whole view; `main` is a GOOS refetch that keeps the old content. */
  readonly mode: 'page' | 'main';
  readonly abort: AbortController;
  readonly timer: unknown;
}

const DEFAULT_TIMEOUT_MS = 20_000;

function errorText(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

function failureReason(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code !== '') {
      return code;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

function failureStatus(failure: SearchFailure): string {
  switch (failure.kind) {
    case 'unreachable':
      return UNREACHABLE;
    case 'http':
      return failure.status === 404 ? DETAIL_NOT_FOUND : httpError(failure.status);
    case 'redirectBlocked':
      return httpError(failure.status);
    case 'timeout':
      return DETAIL_TIMED_OUT;
  }
}

/**
 * Owns the package detail state: fetching and parsing a pkg.go.dev page, GOOS
 * changes, retry, stale-response protection, the installed flag, and the
 * Install/Uninstall stub. Depends only on injected interfaces.
 */
export class DetailController implements DisposableLike {
  private readonly timers: TimerApi;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly listeners = new Set<(message: HostToDetail) => void>();
  private current: DetailViewModel = EMPTY_DETAIL_STATE;
  private generation = 0;
  private inFlight: InFlight | undefined;
  /** The GOOS of the last `changeGoos` request, repeated by `retry`. */
  private requestedGoos: string | undefined;
  private disposed = false;

  constructor(private readonly deps: DetailControllerDeps) {
    this.timers = deps.timers ?? defaultTimerApi;
    this.now = deps.now ?? (() => new Date());
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get state(): DetailViewModel {
    return this.current;
  }

  snapshot(): HostToDetail {
    return { type: 'state', state: this.current };
  }

  onDidChange(listener: (message: HostToDetail) => void): DisposableLike {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /** A package was selected. */
  show(path: string): void {
    if (this.disposed) {
      return;
    }
    if (!isValidImportPath(path)) {
      this.abortInFlight();
      this.requestedGoos = undefined;
      this.setState({ ...EMPTY_DETAIL_STATE, status: 'error', path: String(path).slice(0, 512), error: DETAIL_INVALID_PATH });
      return;
    }
    const { status } = this.current;
    if (path === this.current.path && (status === 'loading' || status === 'ready')) {
      return;
    }
    this.startPage(path);
  }

  /** The GOOS drop-down changed. */
  changeGoos(goos: string): void {
    if (this.disposed || this.current.status !== 'ready') {
      return;
    }
    const options = this.current.detail?.buildContext?.options;
    if (options === undefined || !options.some((option) => option.value === goos)) {
      return;
    }
    this.requestedGoos = goos;
    this.startMain(this.current.path, goos);
  }

  retry(): void {
    if (this.disposed) {
      return;
    }
    const { status, path, error } = this.current;
    if (status === 'error') {
      if (isValidImportPath(path)) {
        this.startPage(path);
      }
    } else if (status === 'ready' && error !== undefined && this.requestedGoos !== undefined) {
      this.startMain(path, this.requestedGoos);
    }
  }

  /** go.mod changed: recompute the installed flag and tell listeners only if it changed. */
  refreshInstalled(): void {
    if (this.disposed || this.current.status !== 'ready') {
      return;
    }
    const installed = this.computeInstalled(this.current.path);
    if (installed === this.current.installed) {
      return;
    }
    this.current = { ...this.current, installed };
    this.emit({ type: 'installed', installed });
  }

  requestInstall(): void {
    this.logStub('install');
  }

  requestUninstall(): void {
    this.logStub('uninstall');
  }

  /** The tab was closed: drop all work and go back to idle. */
  reset(): void {
    if (this.disposed) {
      return;
    }
    this.abortInFlight();
    this.requestedGoos = undefined;
    this.setState(EMPTY_DETAIL_STATE);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.abortInFlight();
    this.listeners.clear();
  }

  private logStub(action: 'install' | 'uninstall'): void {
    if (this.disposed || this.current.path === '') {
      return;
    }
    this.write(installStubLog(this.now().toISOString(), action, this.current.path));
  }

  private computeInstalled(path: string): boolean {
    try {
      return this.deps.isInstalled(path);
    } catch (err) {
      this.log(`isInstalled failed: ${errorText(err)}`);
      return false;
    }
  }

  private startPage(path: string): void {
    this.requestedGoos = undefined;
    this.abortInFlight();
    this.setState({ ...EMPTY_DETAIL_STATE, status: 'loading', path });
    this.request(path, undefined, 'page');
  }

  private startMain(path: string, goos: string): void {
    this.abortInFlight();
    const { error: _error, ...rest } = this.current;
    this.setState({ ...rest, mainLoading: true });
    this.request(path, goos, 'main');
  }

  private request(path: string, goos: string | undefined, mode: 'page' | 'main'): void {
    const built = packageDetailUrl(path, goos);
    if (!built.ok) {
      this.fail(path, goos, mode, { kind: 'unreachable', reason: `invalid request (${built.reason})` });
      return;
    }
    const generation = ++this.generation;
    const abort = new AbortController();
    const timer = this.timers.setTimeout(() => {
      this.settle(generation, { kind: 'timeout' });
    }, this.timeoutMs);
    this.inFlight = { generation, path, goos, mode, abort, timer };

    let pending: Promise<SearchResponse>;
    try {
      pending = Promise.resolve(this.deps.client.search(built.url, abort.signal));
    } catch (err) {
      pending = Promise.reject(err);
    }
    pending.then(
      (response) => {
        this.settle(generation, response);
      },
      (err: unknown) => {
        this.settle(generation, { kind: 'failed', failure: { kind: 'unreachable', reason: failureReason(err) } });
      },
    );
  }

  private abortInFlight(): void {
    const flight = this.inFlight;
    this.generation++;
    if (flight === undefined) {
      return;
    }
    this.inFlight = undefined;
    this.timers.clearTimeout(flight.timer);
    flight.abort.abort();
  }

  /** Applies the outcome of request `generation` unless it was superseded. */
  private settle(generation: number, outcome: DetailOutcome): void {
    try {
      const flight = this.inFlight;
      if (this.disposed || flight === undefined || flight.generation !== generation || this.generation !== generation) {
        return;
      }
      if (outcome?.kind === 'aborted') {
        return;
      }
      this.inFlight = undefined;
      this.timers.clearTimeout(flight.timer);
      if (outcome?.kind === 'timeout') {
        flight.abort.abort();
      }

      let failure: SearchFailure | { readonly kind: 'badPage' } | undefined;
      if (outcome?.kind === 'ok' && typeof outcome.html === 'string') {
        const detail = parsePackageDetail(outcome.html, flight.path);
        if (detail !== undefined) {
          this.setState({
            status: 'ready',
            path: flight.path,
            detail,
            goos: detail.buildContext?.selected ?? flight.goos,
            installed: this.computeInstalled(flight.path),
            mainLoading: false,
          });
          return;
        }
        failure = { kind: 'badPage' };
      } else if (outcome?.kind === 'failed' && outcome.failure !== undefined) {
        failure = outcome.failure;
      } else if (outcome?.kind === 'timeout') {
        failure = { kind: 'timeout' };
      } else {
        failure = { kind: 'unreachable', reason: 'invalid page response' };
      }
      this.fail(flight.path, flight.goos, flight.mode, failure);
    } catch (err) {
      this.log(`Unexpected error while handling a package page: ${errorText(err)}`);
    }
  }

  private fail(
    path: string,
    goos: string | undefined,
    mode: 'page' | 'main',
    failure: SearchFailure | { readonly kind: 'badPage' },
  ): void {
    this.write(detailFailureLog(this.now().toISOString(), path, goos, failure));
    const message = failure.kind === 'badPage' ? DETAIL_BAD_PAGE : failureStatus(failure);
    if (mode === 'page') {
      this.setState({ ...EMPTY_DETAIL_STATE, status: 'error', path, error: message });
    } else {
      this.setState({ ...this.current, mainLoading: false, error: message });
    }
  }

  private setState(state: DetailViewModel): void {
    this.current = state;
    this.emit({ type: 'state', state });
  }

  private emit(message: HostToDetail): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(message);
      } catch (err) {
        this.log(`Listener failed: ${errorText(err)}`);
      }
    }
  }

  private log(message: string): void {
    this.write(`[${this.now().toISOString()}] ${message}`);
  }

  private write(line: string): void {
    try {
      this.deps.output.appendLine(line);
    } catch {
      // Logging must never break the controller.
    }
  }
}
