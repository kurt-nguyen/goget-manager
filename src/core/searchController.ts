import { KeyedDebouncer, defaultTimerApi, type TimerApi } from './debouncer';
import { SEARCHING, TIMED_OUT, UNREACHABLE, httpError, noResults, openFailedLog, openFailedNotification, openRefusedLog, resultCount, searchFailureLog } from './messages';
import { parseSearchResults, type PackageResult } from './resultsParser';
import { buildSearchUrl, packagePageUrl, toSearchQuery } from './searchQuery';
import { EMPTY_VIEW_MODEL, type SearchViewModel } from './searchProtocol';

export type SearchFailure =
  | { readonly kind: 'unreachable'; readonly reason: string }
  | { readonly kind: 'http'; readonly status: number }
  | { readonly kind: 'redirectBlocked'; readonly status: number; readonly targetHost: string }
  | { readonly kind: 'timeout' };

export type SearchResponse =
  | { readonly kind: 'ok'; readonly html: string }
  | { readonly kind: 'failed'; readonly failure: Exclude<SearchFailure, { kind: 'timeout' }> }
  | { readonly kind: 'aborted' };

/** Resolves (never rejects) with the outcome of one search. */
export interface SearchClient {
  search(url: string, signal: AbortSignal): Promise<SearchResponse>;
}

/** The slice of `vscode.OutputChannel` the controller needs. */
export interface OutputLike {
  appendLine(value: string): void;
}

export interface DisposableLike {
  dispose(): void;
}

export interface SearchControllerDeps {
  readonly client: SearchClient;
  readonly output: OutputLike;
  readonly openExternal: (url: string) => PromiseLike<boolean>;
  readonly showError: (message: string) => void;
  /** Timers for the debounce and the request timeout. Default: global timers. */
  readonly timers?: TimerApi;
  /** Clock for output timestamps. Default `() => new Date()`. */
  readonly now?: () => Date;
  /** Debounce_Delay. Default 400. */
  readonly debounceMs?: number;
  /** Request_Timeout. Default 10_000. */
  readonly timeoutMs?: number;
}

type SearchOutcome = SearchResponse | { readonly kind: 'timeout' };

interface InFlight {
  readonly generation: number;
  readonly query: string;
  readonly abort: AbortController;
  readonly timer: unknown;
}

interface LastStarted {
  readonly query: string;
  outcome: 'pending' | 'ok' | 'failed';
}

const DEBOUNCE_KEY = 'search';
const DEFAULT_DEBOUNCE_MS = 400;
const DEFAULT_TIMEOUT_MS = 10_000;

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
    case 'redirectBlocked':
      return httpError(failure.status);
    case 'timeout':
      return TIMED_OUT;
  }
}

/**
 * Owns the search view state: debounce, cancellation, timeout, stale-response
 * protection, and opening result pages. Depends only on injected interfaces.
 */
export class SearchController implements DisposableLike {
  private readonly debouncer: KeyedDebouncer<string>;
  private readonly timers: TimerApi;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly listeners = new Set<(state: SearchViewModel) => void>();
  private current: SearchViewModel = EMPTY_VIEW_MODEL;
  private generation = 0;
  private inFlight: InFlight | undefined;
  private lastStarted: LastStarted | undefined;
  private disposed = false;

  constructor(private readonly deps: SearchControllerDeps) {
    this.timers = deps.timers ?? defaultTimerApi;
    this.now = deps.now ?? (() => new Date());
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.debouncer = new KeyedDebouncer<string>(deps.debounceMs ?? DEFAULT_DEBOUNCE_MS, this.timers);
  }

  get state(): SearchViewModel {
    return this.current;
  }

  onDidChangeState(listener: (state: SearchViewModel) => void): DisposableLike {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /** The Search_Box text changed (typing). */
  queryChanged(text: string): void {
    if (this.disposed) {
      return;
    }
    const query = toSearchQuery(text);
    if (query === '') {
      this.debouncer.cancel(DEBOUNCE_KEY);
      this.abortInFlight();
      this.lastStarted = undefined;
      const hadResults = this.current.results.length > 0;
      if (hadResults || this.current.status !== '' || this.current.loading) {
        this.setState({
          results: [],
          status: '',
          loading: false,
          resultsVersion: hadResults ? this.current.resultsVersion + 1 : this.current.resultsVersion,
        });
      }
      return;
    }
    this.debouncer.schedule(DEBOUNCE_KEY, () => {
      const last = this.lastStarted;
      if (last !== undefined && last.query === query && (last.outcome === 'pending' || last.outcome === 'ok')) {
        return;
      }
      this.start(query);
    });
  }

  /** Enter was pressed in the Search_Box. */
  submit(text: string): void {
    if (this.disposed) {
      return;
    }
    this.debouncer.cancel(DEBOUNCE_KEY);
    const query = toSearchQuery(text);
    if (query === '') {
      return;
    }
    this.start(query);
  }

  /** Opens the package page of a result. Never modifies the state and never rejects. */
  async open(resultsVersion: number, index: number): Promise<void> {
    if (this.disposed || resultsVersion !== this.current.resultsVersion) {
      return;
    }
    const entry = Number.isInteger(index) ? this.current.results[index] : undefined;
    if (entry === undefined) {
      return;
    }
    const path = entry.path;
    try {
      const target = packagePageUrl(path);
      if (!target.ok) {
        this.write(openRefusedLog(this.now().toISOString(), path, target.reason));
        return;
      }
      let opened: boolean;
      try {
        opened = await this.deps.openExternal(target.url);
      } catch (err) {
        this.openFailed(path, failureReason(err));
        return;
      }
      if (!opened) {
        this.openFailed(path, 'the browser could not be opened');
      }
    } catch (err) {
      this.log(`Unexpected error while opening ${JSON.stringify(path)}: ${errorText(err)}`);
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.debouncer.dispose();
    this.abortInFlight();
    this.lastStarted = undefined;
    this.listeners.clear();
  }

  private openFailed(path: string, reason: string): void {
    try {
      this.deps.showError(openFailedNotification(path));
    } catch (err) {
      this.log(`showError failed: ${errorText(err)}`);
    }
    this.write(openFailedLog(this.now().toISOString(), path, reason));
  }

  private start(query: string): void {
    const built = buildSearchUrl(query);
    if (!built.ok) {
      return;
    }
    this.abortInFlight();
    const generation = ++this.generation;
    const abort = new AbortController();
    const timer = this.timers.setTimeout(() => {
      this.settle(generation, { kind: 'timeout' });
    }, this.timeoutMs);
    this.inFlight = { generation, query, abort, timer };
    this.lastStarted = { query, outcome: 'pending' };

    this.setState({ ...this.current, loading: true, status: SEARCHING });
    // A listener may have started or cancelled a search while handling the state change.
    if (this.disposed || this.generation !== generation || this.inFlight?.generation !== generation) {
      return;
    }

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
    if (flight === undefined) {
      return;
    }
    this.inFlight = undefined;
    this.timers.clearTimeout(flight.timer);
    flight.abort.abort();
  }

  /** Applies the outcome of search `generation` unless it was superseded. */
  private settle(generation: number, outcome: SearchOutcome): void {
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

      let failure: SearchFailure | undefined;
      let results: readonly PackageResult[] = [];
      let status = '';
      if (outcome?.kind === 'ok' && typeof outcome.html === 'string') {
        results = parseSearchResults(outcome.html);
        status = results.length > 0 ? resultCount(results.length) : noResults(flight.query);
      } else if (outcome?.kind === 'failed' && outcome.failure !== undefined) {
        failure = outcome.failure;
      } else if (outcome?.kind === 'timeout') {
        failure = { kind: 'timeout' };
      } else {
        failure = { kind: 'unreachable', reason: 'invalid search response' };
      }

      if (this.lastStarted !== undefined && this.lastStarted.query === flight.query) {
        this.lastStarted.outcome = failure === undefined ? 'ok' : 'failed';
      }
      if (failure !== undefined) {
        status = failureStatus(failure);
        this.write(searchFailureLog(this.now().toISOString(), flight.query, failure));
      }
      this.setState({
        results,
        status,
        loading: false,
        resultsVersion: this.current.resultsVersion + 1,
      });
    } catch (err) {
      this.log(`Unexpected error while handling a search result: ${errorText(err)}`);
    }
  }

  private setState(state: SearchViewModel): void {
    this.current = state;
    for (const listener of [...this.listeners]) {
      try {
        listener(state);
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
