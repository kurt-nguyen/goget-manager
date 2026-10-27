// Feature: search-packages, Property 12: Messages across the webview boundary carry only allowed data
/**
 * **Validates: Requirements 8.7**
 *
 * Webview -> host: `parseWebviewMessage` never throws and only ever returns a fresh object holding
 * the allowed keys of one of the four message kinds. Host -> webview: `SearchViewProvider` posts only
 * `{ type: 'state', state: { results, status, loading, resultsVersion } }`, whatever extra properties
 * the controller state carries.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { PackageResult } from '../../../src/core/resultsParser';
import type { SearchController } from '../../../src/core/searchController';
import { parseWebviewMessage, type SearchViewModel, type WebviewToHost } from '../../../src/core/searchProtocol';
import { SearchViewProvider } from '../../../src/vscode/searchViewProvider';
import { Uri } from '../vscodeStub';
import {
  expectedResult,
  createControllerHarness,
  flushPromises,
  plainPage,
  renderPage,
  validEntrySpecArb,
} from '../searchArbitraries';

const RUNS = 200;
const MAX_CODE_POINTS = 256;

// ---------------------------------------------------------------------------
// Independent oracle and output invariants
// ---------------------------------------------------------------------------

const ALLOWED_KEYS: Readonly<Record<string, readonly string[]>> = {
  ready: ['type'],
  query: ['text', 'type'],
  submit: ['text', 'type'],
  open: ['index', 'resultsVersion', 'type'],
};

const isNonNegativeInteger = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;

const clamp = (text: string): string => Array.from(text).slice(0, MAX_CODE_POINTS).join('');

/** What a plain-data message must parse to (no getters, no proxies). */
function reference(value: unknown): WebviewToHost | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const r = value as Record<string, unknown>;
  switch (r.type) {
    case 'ready':
      return { type: 'ready' };
    case 'query':
    case 'submit':
      return typeof r.text === 'string' ? { type: r.type, text: clamp(r.text) } : undefined;
    case 'open':
      return isNonNegativeInteger(r.resultsVersion) && isNonNegativeInteger(r.index)
        ? { type: 'open', resultsVersion: r.resultsVersion, index: r.index }
        : undefined;
    default:
      return undefined;
  }
}

/** Shape invariants that hold for every output, valid input or not. */
function expectWellFormed(output: WebviewToHost | undefined): void {
  if (output === undefined) {
    return;
  }
  expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
  expect(Object.getOwnPropertySymbols(output)).toEqual([]);
  const keys = Object.getOwnPropertyNames(output).sort();
  expect(keys).toEqual(ALLOWED_KEYS[output.type]);
  switch (output.type) {
    case 'ready':
      break;
    case 'query':
    case 'submit':
      expect(typeof output.text).toBe('string');
      expect(Array.from(output.text).length).toBeLessThanOrEqual(MAX_CODE_POINTS);
      break;
    case 'open':
      expect(isNonNegativeInteger(output.resultsVersion)).toBe(true);
      expect(isNonNegativeInteger(output.index)).toBe(true);
      break;
  }
}

function expectPrototypeClean(): void {
  const probe = {} as Record<string, unknown>;
  for (const key of ['type', 'text', 'index', 'resultsVersion', 'polluted']) {
    expect(probe[key]).toBeUndefined();
  }
  expect(Object.getPrototypeOf(Object.prototype)).toBeNull();
}

// ---------------------------------------------------------------------------
// Generators for near-valid messages
// ---------------------------------------------------------------------------

interface Case {
  readonly input: unknown;
  /** `'any'` = only the shape invariants are checked. */
  readonly expected: WebviewToHost | undefined | 'any';
}

const textValueArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 4, arbitrary: fc.string({ maxLength: 40 }) },
  { weight: 2, arbitrary: fc.string({ unit: 'binary', maxLength: 40 }) },
  { weight: 1, arbitrary: fc.string({ unit: 'binary', minLength: 250, maxLength: 600 }) },
  { weight: 1, arbitrary: fc.integer({ min: 250, max: 300 }).map((n) => '\u{1F600}'.repeat(n)) },
  { weight: 1, arbitrary: fc.constantFrom('a'.repeat(100_000), '\u{1F600}'.repeat(100_000), '\ud800'.repeat(1_000)) },
  { weight: 1, arbitrary: fc.constantFrom('', ' ', '\n', '__proto__', 'constructor') },
);

const goodNumberArb: fc.Arbitrary<number> = fc.oneof(
  fc.nat(),
  fc.constantFrom(0, -0, 1, Number.MAX_SAFE_INTEGER, 2 ** 31, 2 ** 32),
);

const badNumberLikeArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constantFrom<unknown>(
    -1,
    -0.5,
    0.5,
    1.5,
    NaN,
    Infinity,
    -Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    2 ** 53,
    1e21,
    Number.MIN_VALUE,
    '1',
    '0',
    '',
    null,
    undefined,
    true,
    false,
    1n,
    [],
    [1],
    {},
    { valueOf: () => 1 },
    () => 1,
  ),
  fc.integer({ min: -1000, max: -1 }),
  fc.double({ noInteger: true, noNaN: true }).filter((d) => !Number.isInteger(d)),
);

const badTextArb: fc.Arbitrary<unknown> = fc.constantFrom<unknown>(
  1,
  0,
  NaN,
  null,
  undefined,
  true,
  false,
  [],
  ['a'],
  {},
  { toString: () => 'a' },
  // eslint-disable-next-line no-new-wrappers
  new String('a'),
  () => 'a',
  Symbol('a'),
  1n,
);

const EXTRA_KEYS = [
  'text',
  'index',
  'resultsVersion',
  'url',
  'path',
  'extra',
  'results',
  'state',
  'constructor',
  'toString',
  'hasOwnProperty',
  'prototype',
  '__proto__',
  '__defineGetter__',
  'x',
] as const;

const extraValueArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.jsonValue(),
  fc.constantFrom<unknown>({ type: 'ready' }, { polluted: true }, { text: 'evil' }, 'evil', 42),
);

const extrasArb = fc.array(fc.tuple(fc.constantFrom(...EXTRA_KEYS), extraValueArb), { maxLength: 5 });

/** Defines own enumerable data properties, including a literal own `__proto__`. */
function build(entries: ReadonlyArray<readonly [string, unknown]>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

function withExtras(
  base: ReadonlyArray<readonly [string, unknown]>,
  extras: ReadonlyArray<readonly [string, unknown]>,
  extrasFirst: boolean,
): Record<string, unknown> {
  const taken = new Set(base.map(([k]) => k));
  const usable = extras.filter(([k]) => !taken.has(k));
  return build(extrasFirst ? [...usable, ...base] : [...base, ...usable]);
}

const messageBaseArb: fc.Arbitrary<{
  readonly entries: ReadonlyArray<readonly [string, unknown]>;
  readonly expected: WebviewToHost;
}> = fc.oneof(
  fc.constant({ entries: [['type', 'ready']] as const, expected: { type: 'ready' } as WebviewToHost }),
  fc
    .tuple(fc.constantFrom('query', 'submit'), textValueArb)
    .map(([type, text]) => ({
      entries: [
        ['type', type],
        ['text', text],
      ] as const,
      expected: { type, text: clamp(text) } as WebviewToHost,
    })),
  fc.tuple(goodNumberArb, goodNumberArb).map(([resultsVersion, index]) => ({
    entries: [
      ['type', 'open'],
      ['resultsVersion', resultsVersion],
      ['index', index],
    ] as const,
    expected: { type: 'open', resultsVersion, index } as WebviewToHost,
  })),
);

/** Valid core plus extra keys: extras must be stripped. */
const validWithExtrasArb: fc.Arbitrary<Case> = fc
  .tuple(messageBaseArb, extrasArb, fc.boolean())
  .map(([base, extras, extrasFirst]) => ({
    input: withExtras(base.entries, extras, extrasFirst),
    expected: base.expected,
  }));

/** Right type, wrong payload types or numbers. */
const wrongPayloadArb: fc.Arbitrary<Case> = fc.oneof(
  fc
    .tuple(fc.constantFrom('query', 'submit'), badTextArb)
    .map(([type, text]): Case => ({ input: build([['type', type], ['text', text]]), expected: undefined })),
  fc.constantFrom('query', 'submit').map((type): Case => ({ input: build([['type', type]]), expected: undefined })),
  fc
    .tuple(badNumberLikeArb, goodNumberArb, fc.boolean())
    .map(([bad, good, badFirst]): Case => ({
      input: build([
        ['type', 'open'],
        ['resultsVersion', badFirst ? bad : good],
        ['index', badFirst ? good : bad],
      ]),
      expected: undefined,
    })),
  fc
    .tuple(badNumberLikeArb, badNumberLikeArb)
    .map(([a, b]): Case => ({
      input: build([['type', 'open'], ['resultsVersion', a], ['index', b]]),
      expected: undefined,
    })),
  fc.constant<Case>({ input: build([['type', 'open']]), expected: undefined }),
  fc.constant<Case>({ input: build([['type', 'open'], ['index', 1]]), expected: undefined }),
);

/** Wrong or unknown `type`. */
const wrongTypeArb: fc.Arbitrary<Case> = fc
  .tuple(
    fc.oneof(
      fc.string({ maxLength: 12 }).filter((s) => !(s in ALLOWED_KEYS) || s === '__proto__'),
      fc.constantFrom<unknown>(
        'READY',
        'Ready',
        ' ready',
        'ready ',
        'state',
        'open ',
        'toString',
        'constructor',
        '__proto__',
        '',
        1,
        0,
        null,
        undefined,
        true,
        ['ready'],
        { toString: () => 'ready' },
        // eslint-disable-next-line no-new-wrappers
        new String('ready'),
      ),
    ),
    extrasArb,
  )
  .map(([type, extras]): Case => ({
    input: withExtras([['type', type], ['text', 'x'], ['resultsVersion', 0], ['index', 0]], extras, false),
    expected: undefined,
  }));

function throwingGetter(
  key: string,
  base: ReadonlyArray<readonly [string, unknown]>,
): Record<string, unknown> {
  const out = build(base.filter(([k]) => k !== key));
  Object.defineProperty(out, key, {
    enumerable: true,
    configurable: true,
    get(): never {
      throw new Error(`boom: ${key}`);
    },
  });
  return out;
}

const THROW_PROXY = new Proxy(
  {},
  {
    get(): never {
      throw new Error('proxy get');
    },
    getPrototypeOf(): never {
      throw new Error('proxy getPrototypeOf');
    },
    has(): never {
      throw new Error('proxy has');
    },
    ownKeys(): never {
      throw new Error('proxy ownKeys');
    },
    getOwnPropertyDescriptor(): never {
      throw new Error('proxy gopd');
    },
  },
);

const REVOKED_PROXY = (() => {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
})();

/** A message whose accessors or proxy traps throw. */
const throwingArb: fc.Arbitrary<Case> = fc.oneof(
  fc.constantFrom<Case>(
    { input: throwingGetter('type', [['type', 'ready']]), expected: undefined },
    { input: throwingGetter('type', [['type', 'query'], ['text', 'x']]), expected: undefined },
    { input: throwingGetter('text', [['type', 'query'], ['text', 'x']]), expected: undefined },
    { input: throwingGetter('text', [['type', 'submit'], ['text', 'x']]), expected: undefined },
    { input: throwingGetter('resultsVersion', [['type', 'open'], ['resultsVersion', 1], ['index', 1]]), expected: undefined },
    { input: throwingGetter('index', [['type', 'open'], ['resultsVersion', 1], ['index', 1]]), expected: undefined },
    { input: THROW_PROXY, expected: undefined },
    { input: REVOKED_PROXY, expected: undefined },
    { input: new Proxy({ type: 'ready' }, { get() { throw new Error('trap'); } }), expected: undefined },
  ),
  // A throwing getter on a key the parser does not read must not matter.
  fc.constantFrom('extra', 'url', '__proto__', 'constructor').chain((key) =>
    messageBaseArb.map(
      (base): Case => ({
        input: throwingGetter(key, base.entries),
        expected: base.expected,
      }),
    ),
  ),
  // Own `toString`/`valueOf` that throw, on a valid message.
  messageBaseArb.map(
    (base): Case => ({
      input: Object.assign(build(base.entries), {
        toString(): never {
          throw new Error('toString');
        },
        valueOf(): never {
          throw new Error('valueOf');
        },
      }),
      expected: base.expected,
    }),
  ),
);

/** Values that are not plain objects at all. */
const nonObjectArb: fc.Arbitrary<Case> = fc
  .constantFrom<unknown>(
    undefined,
    null,
    true,
    0,
    NaN,
    '',
    'ready',
    '{"type":"ready"}',
    Symbol('s'),
    1n,
    () => ({ type: 'ready' }),
    [],
    ['ready'],
    [{ type: 'ready' }],
    Object.assign([], { type: 'ready' }),
    Object.assign(() => 1, { type: 'ready' }),
  )
  .map((input): Case => ({ input, expected: undefined }));

/**
 * Cases hold getters and proxies that throw, so fast-check must not walk into `input` when it
 * prints a counterexample. The label is a safe summary instead.
 */
function labelled(kind: string): (c: Case) => Case {
  return (c) =>
    Object.defineProperty(c, fc.toStringMethod, {
      configurable: true,
      value: () => {
        let shown: string;
        try {
          shown = JSON.stringify(c.input) ?? String(c.input);
        } catch {
          shown = '<unprintable input>';
        }
        return `${kind}: ${shown.slice(0, 200)} => ${JSON.stringify(c.expected) ?? 'undefined'}`;
      },
    });
}

const craftedArb: fc.Arbitrary<Case> = fc.oneof(
  { weight: 4, arbitrary: validWithExtrasArb.map(labelled('valid+extras')) },
  { weight: 3, arbitrary: wrongPayloadArb.map(labelled('wrong payload')) },
  { weight: 2, arbitrary: wrongTypeArb.map(labelled('wrong type')) },
  { weight: 2, arbitrary: throwingArb.map(labelled('throwing')) },
  { weight: 1, arbitrary: nonObjectArb.map(labelled('non-object')) },
);

/** `JSON.parse` of text with literal `__proto__` keys, as a real postMessage payload could carry. */
const protoJsonArb: fc.Arbitrary<Case> = fc
  .tuple(
    fc.constantFrom(
      '{"type":"ready","__proto__":{"type":"query","text":"evil"}}',
      '{"__proto__":{"type":"ready"},"type":"query","text":"hello"}',
      '{"type":"submit","text":"a","__proto__":{"polluted":true}}',
      '{"type":"open","resultsVersion":1,"index":2,"__proto__":null}',
      '{"type":"query","__proto__":{"text":"inherited"}}',
      '{"type":"query","text":"x","constructor":{"prototype":{"polluted":true}}}',
      '{"__proto__":{"type":"ready"}}',
    ),
  )
  .map(([json]): Case => {
    const input = JSON.parse(json) as unknown;
    return { input, expected: reference(input) };
  });

// ---------------------------------------------------------------------------
// Property: parseWebviewMessage
// ---------------------------------------------------------------------------

function checkParse(input: unknown, expected: Case['expected']): void {
  let output: WebviewToHost | undefined;
  expect(() => {
    output = parseWebviewMessage(input);
  }).not.toThrow();
  expectWellFormed(output);
  if (expected !== 'any') {
    expect(output).toEqual(expected);
  }
  if (output !== undefined) {
    // A fresh object every call, never the input and never shared between calls.
    expect(Object.is(output, input)).toBe(false);
    const again = parseWebviewMessage(input);
    expect(again).toEqual(output);
    expect(Object.is(again, output)).toBe(false);
  }
  expectPrototypeClean();
}

describe('Property 12: messages across the webview boundary carry only allowed data', () => {
  describe('parseWebviewMessage', () => {
    it('accepts only the allowed shapes for arbitrary JSON values', () => {
      fc.assert(
        fc.property(fc.jsonValue(), (value) => {
          checkParse(value, reference(value));
        }),
        { numRuns: RUNS },
      );
    });

    it('accepts only the allowed shapes for JSON objects shaped like messages', () => {
      const messageLike = fc.record(
        {
          type: fc.oneof(fc.constantFrom('ready', 'query', 'submit', 'open', 'state'), fc.jsonValue()),
          text: fc.oneof(textValueArb, fc.jsonValue()),
          resultsVersion: fc.oneof(goodNumberArb, fc.jsonValue()),
          index: fc.oneof(goodNumberArb, fc.jsonValue()),
          extra: fc.jsonValue(),
        },
        { requiredKeys: [] },
      );
      fc.assert(
        fc.property(messageLike, (value) => {
          checkParse(value, reference(value));
        }),
        { numRuns: RUNS },
      );
    });

    it('strips extras, rejects wrong types, and survives throwing accessors on crafted near-valid messages', () => {
      fc.assert(
        fc.property(craftedArb, ({ input, expected }) => {
          checkParse(input, expected);
        }),
        { numRuns: RUNS },
      );
    });

    it('is not fooled by literal __proto__ keys from JSON.parse', () => {
      fc.assert(
        fc.property(protoJsonArb, ({ input, expected }) => {
          checkParse(input, expected);
        }),
        { numRuns: 100 },
      );
    });

    it('clamps text to 256 code points without splitting a surrogate pair', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('query', 'submit'),
          fc.string({ unit: 'binary', maxLength: 700 }),
          (type, text) => {
            const out = parseWebviewMessage({ type, text });
            expect(out).toEqual({ type, text: clamp(text) });
            expectWellFormed(out);
          },
        ),
        { numRuns: RUNS },
      );
    });
  });

  // -------------------------------------------------------------------------
  // SearchViewProvider: both directions of the boundary
  // -------------------------------------------------------------------------

  type Listener = (raw: unknown) => void;

  class FakeWebview {
    options: unknown;
    html = '';
    readonly cspSource = 'vscode-resource:';
    readonly posted: unknown[] = [];
    private listeners: Listener[] = [];

    asWebviewUri(uri: Uri): Uri {
      return uri;
    }

    postMessage(message: unknown): Promise<boolean> {
      this.posted.push(message);
      return Promise.resolve(true);
    }

    onDidReceiveMessage(listener: Listener): { dispose(): void } {
      this.listeners.push(listener);
      return {
        dispose: () => {
          this.listeners = this.listeners.filter((l) => l !== listener);
        },
      };
    }

    receive(raw: unknown): void {
      for (const listener of [...this.listeners]) {
        listener(raw);
      }
    }
  }

  class FakeView {
    readonly webview = new FakeWebview();
    onDidDispose(): { dispose(): void } {
      return { dispose: () => undefined };
    }
  }

  type ControllerCall =
    | readonly ['query', string]
    | readonly ['submit', string]
    | readonly ['open', number, number];

  /** Minimal controller whose state may carry arbitrary extra properties. */
  class FakeController {
    state: SearchViewModel;
    readonly calls: ControllerCall[] = [];
    private listeners: Array<(state: SearchViewModel) => void> = [];

    constructor(state: SearchViewModel) {
      this.state = state;
    }

    onDidChangeState(listener: (state: SearchViewModel) => void): { dispose(): void } {
      this.listeners.push(listener);
      return {
        dispose: () => {
          this.listeners = this.listeners.filter((l) => l !== listener);
        },
      };
    }

    emit(state: SearchViewModel): void {
      this.state = state;
      for (const listener of [...this.listeners]) {
        listener(state);
      }
    }

    queryChanged(text: string): void {
      this.calls.push(['query', text]);
    }

    submit(text: string): void {
      this.calls.push(['submit', text]);
    }

    open(resultsVersion: number, index: number): Promise<void> {
      this.calls.push(['open', resultsVersion, index]);
      return Promise.resolve();
    }
  }

  function mount(controller: unknown): FakeView {
    const provider = new SearchViewProvider(Uri.file('/ext') as never, controller as SearchController);
    const view = new FakeView();
    provider.resolveWebviewView(view as never);
    return view;
  }

  function expectOnlyStateMessages(posted: readonly unknown[]): void {
    for (const message of posted) {
      expect(Object.getOwnPropertyNames(message).sort()).toEqual(['state', 'type']);
      const m = message as { type: unknown; state: Record<string, unknown> };
      expect(m.type).toBe('state');
      expect(Object.getOwnPropertyNames(m.state).sort()).toEqual(['loading', 'results', 'resultsVersion', 'status']);
      expect(Object.getOwnPropertySymbols(m.state)).toEqual([]);
    }
  }

  const packageResultArb: fc.Arbitrary<PackageResult> = validEntrySpecArb
    .map((spec) => expectedResult(spec))
    .filter((r): r is PackageResult => r !== undefined);

  const STATE_EXTRA_KEYS = [
    'query',
    'selected',
    'debug',
    'url',
    'token',
    'html',
    'secret',
    'inFlight',
    'lastStarted',
    'type',
    'state',
    '__proto__',
  ] as const;

  const stateArb: fc.Arbitrary<SearchViewModel> = fc
    .tuple(
      fc.array(packageResultArb, { maxLength: 4 }),
      fc.string({ maxLength: 30 }),
      fc.boolean(),
      fc.nat(),
      fc.array(fc.tuple(fc.constantFrom(...STATE_EXTRA_KEYS), extraValueArb), { maxLength: 4 }),
    )
    .map(([results, status, loading, resultsVersion, extras]) => {
      const base: Array<readonly [string, unknown]> = [
        ['results', results],
        ['status', status],
        ['loading', loading],
        ['resultsVersion', resultsVersion],
      ];
      return withExtras(base, extras, false) as unknown as SearchViewModel;
    });

  it('posts only {type, state:{results,status,loading,resultsVersion}} however many extras the controller state has', () => {
    fc.assert(
      fc.property(stateArb, fc.array(stateArb, { maxLength: 4 }), (initial, later) => {
        const controller = new FakeController(initial);
        const view = mount(controller);

        view.webview.receive({ type: 'ready' });
        for (const state of later) {
          controller.emit(state);
        }

        expect(view.webview.posted).toHaveLength(1 + later.length);
        expectOnlyStateMessages(view.webview.posted);

        const states = [initial, ...later];
        view.webview.posted.forEach((message, i) => {
          const sent = (message as { state: SearchViewModel }).state;
          const source = states[i] as SearchViewModel;
          expect(sent.results).toEqual(source.results);
          expect(sent.status).toBe(source.status);
          expect(sent.loading).toBe(source.loading);
          expect(sent.resultsVersion).toBe(source.resultsVersion);
        });
        expectPrototypeClean();
      }),
      { numRuns: RUNS },
    );
  });

  it('relays only validated messages to the controller, and never throws on hostile input', () => {
    const hostileArb = fc.oneof(
      fc.jsonValue().map((input): Case => ({ input, expected: 'any' })),
      craftedArb,
      protoJsonArb,
    );
    fc.assert(
      fc.property(fc.array(hostileArb, { minLength: 1, maxLength: 6 }), (cases) => {
        const controller = new FakeController({ results: [], status: '', loading: false, resultsVersion: 0 });
        const view = mount(controller);

        const expectedCalls: ControllerCall[] = [];
        let expectedReady = 0;
        for (const { input } of cases) {
          expect(() => view.webview.receive(input)).not.toThrow();
          const parsed = parseWebviewMessage(input);
          if (parsed === undefined) {
            continue;
          }
          switch (parsed.type) {
            case 'ready':
              expectedReady++;
              break;
            case 'query':
              expectedCalls.push(['query', parsed.text]);
              break;
            case 'submit':
              expectedCalls.push(['submit', parsed.text]);
              break;
            case 'open':
              expectedCalls.push(['open', parsed.resultsVersion, parsed.index]);
              break;
          }
        }

        expect(controller.calls).toEqual(expectedCalls);
        for (const call of controller.calls) {
          if (call[0] !== 'open') {
            expect(Array.from(call[1]).length).toBeLessThanOrEqual(MAX_CODE_POINTS);
          } else {
            expect(isNonNegativeInteger(call[1])).toBe(true);
            expect(isNonNegativeInteger(call[2])).toBe(true);
          }
        }
        expect(view.webview.posted).toHaveLength(expectedReady);
        expectOnlyStateMessages(view.webview.posted);
        expectPrototypeClean();
      }),
      { numRuns: RUNS },
    );
  });

  it('posts only allowed keys while a real SearchController runs a search and opens a result', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(validEntrySpecArb, { minLength: 0, maxLength: 4 }),
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim() !== ''),
        fc.nat({ max: 5 }),
        async (specs, text, index) => {
          const harness = createControllerHarness();
          const view = mount(harness.controller);

          view.webview.receive({ type: 'ready' });
          view.webview.receive({ type: 'query', text });
          harness.timers.advance(400);
          expect(harness.client.calls).toHaveLength(1);
          harness.client.calls[0]!.settle({ kind: 'ok', html: renderPage(plainPage(specs)) });
          await flushPromises();
          view.webview.receive({ type: 'open', resultsVersion: harness.controller.state.resultsVersion, index });
          view.webview.receive({ type: 'submit', text });
          await flushPromises();

          expect(view.webview.posted.length).toBeGreaterThanOrEqual(3);
          expectOnlyStateMessages(view.webview.posted);
          const last = view.webview.posted.at(-1) as { state: SearchViewModel };
          expect(last.state).toEqual({
            results: harness.controller.state.results,
            status: harness.controller.state.status,
            loading: harness.controller.state.loading,
            resultsVersion: harness.controller.state.resultsVersion,
          });
          harness.controller.dispose();
        },
      ),
      { numRuns: 100 },
    );
  });
});
