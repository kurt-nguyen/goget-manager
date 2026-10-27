import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { SearchResponse } from '../../../src/core/searchController';
import { buildSearchUrl, isPkgGoDevHttpsUrl } from '../../../src/core/searchQuery';
import {
  MAX_BODY_BYTES,
  MAX_REDIRECTS,
  PkgGoDevSearchClient,
  REQUEST_HEADERS,
  type HttpTransport,
  type RawHttpResponse,
} from '../../../src/vscode/searchClient';

// Feature: search-packages, Property 10: The search client contacts only HTTPS pkg.go.dev with fixed headers
// **Validates: Requirements 8.1, 8.2, 8.3**

const RUNS = 200;
const REDIRECT_STATUSES = [301, 302, 303, 307, 308] as const;
const TAIL_BODY = 'tail-body';

const LITERAL_HEADERS = {
  Accept: 'text/html',
  'Accept-Encoding': 'identity',
  'User-Agent': 'goget-manager-vscode',
};

// --- hop model --------------------------------------------------------------

type Hop =
  | { readonly kind: 'ok'; readonly status: number; readonly body: string }
  | { readonly kind: 'status'; readonly status: number; readonly location: string | undefined }
  | { readonly kind: 'redirectAllowed'; readonly status: number; readonly location: string; readonly href: string }
  | { readonly kind: 'redirectBlocked'; readonly status: number; readonly location: string; readonly host: string }
  | { readonly kind: 'reject'; readonly error: unknown; readonly reason: string; readonly abort: boolean };

// Segments start with a letter so they are never `.` or `..` (WHATWG URL removes dot segments).
const segmentArb = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
    fc.string({ unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_.'.split('')), maxLength: 7 }),
  )
  .map(([head, tail]) => head + tail);
const pathArb = fc
  .array(segmentArb, { minLength: 1, maxLength: 4 })
  .map((segments) => segments.join('/'));
const querySuffixArb = fc.constantFrom('', '?q=x', '?a=1&b=2');

const redirectStatusArb = fc.constantFrom(...REDIRECT_STATUSES);

const nonRedirectErrorStatusArb = fc
  .integer({ min: 100, max: 599 })
  .filter((s) => !(s >= 200 && s <= 299) && !(REDIRECT_STATUSES as readonly number[]).includes(s));

const okHopArb: fc.Arbitrary<Hop> = fc.record({
  kind: fc.constant('ok' as const),
  status: fc.integer({ min: 200, max: 299 }),
  body: fc.string({ unit: 'binary', maxLength: 40 }),
});

const statusHopArb: fc.Arbitrary<Hop> = fc.oneof(
  // Non-redirect statuses, with or without a Location header.
  fc.record({
    kind: fc.constant('status' as const),
    status: nonRedirectErrorStatusArb,
    location: fc.option(fc.constantFrom('/x', 'https://example.com/'), { nil: undefined }),
  }),
  // Redirect statuses without a usable Location.
  fc.record({
    kind: fc.constant('status' as const),
    status: redirectStatusArb,
    location: fc.constantFrom<string | undefined>(undefined, ''),
  }),
);

const allowedRedirectArb: fc.Arbitrary<Hop> = fc
  .tuple(
    redirectStatusArb,
    pathArb,
    querySuffixArb,
    fc.constantFrom(
      (p: string) => ({ location: `/${p}`, href: `https://pkg.go.dev/${p}` }),
      (p: string) => ({ location: `//pkg.go.dev/${p}`, href: `https://pkg.go.dev/${p}` }),
      (p: string) => ({ location: `https://pkg.go.dev/${p}`, href: `https://pkg.go.dev/${p}` }),
      (p: string) => ({ location: `https://pkg.go.dev:443/${p}`, href: `https://pkg.go.dev/${p}` }),
      (p: string) => ({ location: `HTTPS://PKG.GO.DEV/${p}`, href: `https://pkg.go.dev/${p}` }),
    ),
  )
  .map(([status, p, q, make]) => {
    const built = make(p);
    return {
      kind: 'redirectAllowed' as const,
      status,
      location: built.location + q,
      href: built.href + q,
    };
  });

/** Locations that must be blocked, with the host the failure must report. */
const BLOCKED_TEMPLATES: readonly { readonly prefix: string; readonly host: string }[] = [
  { prefix: 'https://example.com/', host: 'example.com' },
  { prefix: 'https://other.org:8443/', host: 'other.org:8443' },
  { prefix: 'http://pkg.go.dev/', host: 'pkg.go.dev' },
  { prefix: 'http://pkg.go.dev:80/', host: 'pkg.go.dev' },
  { prefix: 'https://pkg.go.dev:8443/', host: 'pkg.go.dev:8443' },
  { prefix: 'https://pkg.go.dev:444/', host: 'pkg.go.dev:444' },
  { prefix: 'https://user:pw@pkg.go.dev/', host: 'pkg.go.dev' },
  { prefix: 'https://user@pkg.go.dev/', host: 'pkg.go.dev' },
  { prefix: 'https://pkg.go.dev.evil.com/', host: 'pkg.go.dev.evil.com' },
  { prefix: 'https://PKG.GO.DEV.EVIL.COM/', host: 'pkg.go.dev.evil.com' },
  { prefix: 'https://evil.pkg.go.dev/', host: 'evil.pkg.go.dev' },
  { prefix: 'https://evilpkg.go.dev/', host: 'evilpkg.go.dev' },
  { prefix: 'https://pkg.go.dev@evil.com/', host: 'evil.com' },
  { prefix: 'https://evil.com\\@pkg.go.dev/', host: 'evil.com' },
  { prefix: 'https://pkg.go.dev./', host: 'pkg.go.dev.' },
  { prefix: '//evil.com/', host: 'evil.com' },
  { prefix: 'ftp://pkg.go.dev/', host: 'pkg.go.dev' },
];

const blockedRedirectArb: fc.Arbitrary<Hop> = fc
  .tuple(redirectStatusArb, fc.constantFrom(...BLOCKED_TEMPLATES), pathArb)
  .map(([status, template, p]) => ({
    kind: 'redirectBlocked' as const,
    status,
    location: template.prefix + p,
    host: template.host,
  }));

/** Locations that WHATWG URL parsing rejects, even against an https base. */
const malformedRedirectArb: fc.Arbitrary<Hop> = fc
  .tuple(redirectStatusArb, fc.constantFrom('https://', 'http://[::1', 'https://exa mple.com/', 'https://[/', 'https://%zz/', 'http://'))
  .map(([status, location]) => ({
    kind: 'redirectBlocked' as const,
    status,
    location,
    host: '(invalid URL)',
  }));

const errorWithCodeArb: fc.Arbitrary<Hop> = fc
  .tuple(
    fc.constantFrom('ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'CERT_HAS_EXPIRED'),
    fc.string({ minLength: 1, maxLength: 20 }),
    fc.boolean(),
  )
  .map(([code, message, abort]) => ({
    kind: 'reject' as const,
    error: Object.assign(new Error(message), { code }),
    reason: code,
    abort,
  }));

const errorWithMessageArb: fc.Arbitrary<Hop> = fc
  .tuple(fc.string({ minLength: 1, maxLength: 30 }), fc.boolean())
  .map(([message, abort]) => ({
    kind: 'reject' as const,
    error: new Error(message),
    reason: message,
    abort,
  }));

const nonErrorRejectArb: fc.Arbitrary<Hop> = fc
  .tuple(fc.string({ minLength: 1, maxLength: 20 }), fc.boolean())
  .map(([text, abort]) => ({ kind: 'reject' as const, error: text, reason: text, abort }));

const rejectHopArb: fc.Arbitrary<Hop> = fc.oneof(errorWithCodeArb, errorWithMessageArb, nonErrorRejectArb);

const hopArb: fc.Arbitrary<Hop> = fc.oneof(
  { weight: 2, arbitrary: okHopArb },
  { weight: 3, arbitrary: statusHopArb },
  { weight: 6, arbitrary: allowedRedirectArb },
  { weight: 4, arbitrary: blockedRedirectArb },
  { weight: 1, arbitrary: malformedRedirectArb },
  { weight: 2, arbitrary: rejectHopArb },
);

/** Chains that follow many allowed redirects, so the hop limit is reached often. */
const longChainArb: fc.Arbitrary<readonly Hop[]> = fc
  .tuple(
    fc.array(allowedRedirectArb, { minLength: 4, maxLength: 8 }),
    fc.option(hopArb, { nil: undefined }),
  )
  .map(([redirects, last]) => (last === undefined ? redirects : [...redirects, last]));

const shortChainArb: fc.Arbitrary<readonly Hop[]> = fc.array(hopArb, { minLength: 0, maxLength: 8 });

const chainArb: fc.Arbitrary<readonly Hop[]> = fc.oneof(
  { weight: 3, arbitrary: shortChainArb },
  { weight: 2, arbitrary: longChainArb },
);

const initialUrlArb: fc.Arbitrary<string> = fc
  .string({ unit: 'binary', minLength: 1, maxLength: 30 })
  .map((text) => {
    const built = buildSearchUrl(text);
    return built.ok ? built.url : 'https://pkg.go.dev/search?q=x&m=package';
  });

const disallowedInitialUrlArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(
    'http://pkg.go.dev/search?q=x&m=package',
    'https://pkg.go.dev:8443/search?q=x',
    'https://user:pw@pkg.go.dev/search?q=x',
    'https://pkg.go.dev.evil.com/search?q=x',
    'https://example.com/search?q=x',
    'not a url',
    '',
    '/search?q=x',
  ),
  fc.string({ unit: 'binary', maxLength: 30 }).filter((s) => !isPkgGoDevHttpsUrl(s)),
);

// --- recording transport and reference model ---------------------------------

interface RecordedCall {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly maxBodyBytes: number;
}

function createFakeTransport(chain: readonly Hop[], controller: AbortController) {
  const calls: RecordedCall[] = [];
  const transport: HttpTransport = {
    get(url, headers, signal, maxBodyBytes) {
      const index = calls.length;
      calls.push({ url, headers, signal, maxBodyBytes });
      const hop = chain[index];
      if (hop === undefined) {
        return Promise.resolve<RawHttpResponse>({ status: 200, body: TAIL_BODY });
      }
      switch (hop.kind) {
        case 'ok':
          return Promise.resolve<RawHttpResponse>({ status: hop.status, body: hop.body });
        case 'status':
          return Promise.resolve<RawHttpResponse>(
            hop.location === undefined
              ? { status: hop.status, body: 'x' }
              : { status: hop.status, location: hop.location, body: 'x' },
          );
        case 'redirectAllowed':
        case 'redirectBlocked':
          return Promise.resolve<RawHttpResponse>({ status: hop.status, location: hop.location, body: 'redirect' });
        case 'reject':
          if (hop.abort) {
            controller.abort();
          }
          return Promise.reject(hop.error);
      }
    },
  };
  return { transport, calls };
}

interface Expected {
  readonly requests: readonly string[];
  readonly response: SearchResponse;
}

function expectedFor(initial: string, chain: readonly Hop[]): Expected {
  const requests: string[] = [];
  let current = initial;
  let followed = 0;
  for (let index = 0; ; index++) {
    requests.push(current);
    const hop = chain[index];
    if (hop === undefined) {
      return { requests, response: { kind: 'ok', html: TAIL_BODY } };
    }
    switch (hop.kind) {
      case 'ok':
        return { requests, response: { kind: 'ok', html: hop.body } };
      case 'status':
        return { requests, response: { kind: 'failed', failure: { kind: 'http', status: hop.status } } };
      case 'reject':
        return {
          requests,
          response: hop.abort
            ? { kind: 'aborted' }
            : { kind: 'failed', failure: { kind: 'unreachable', reason: hop.reason } },
        };
      case 'redirectBlocked':
        return {
          requests,
          response: {
            kind: 'failed',
            failure: { kind: 'redirectBlocked', status: hop.status, targetHost: hop.host },
          },
        };
      case 'redirectAllowed':
        if (followed >= MAX_REDIRECTS) {
          return { requests, response: { kind: 'failed', failure: { kind: 'http', status: hop.status } } };
        }
        followed++;
        current = hop.href;
        break;
    }
  }
}

async function runChain(initial: string, chain: readonly Hop[]) {
  const controller = new AbortController();
  const { transport, calls } = createFakeTransport(chain, controller);
  const client = new PkgGoDevSearchClient(transport);
  const response = await client.search(initial, controller.signal);
  return { response, calls, signal: controller.signal };
}

// --- properties ---------------------------------------------------------------

describe('Property 10: The search client contacts only HTTPS pkg.go.dev with fixed headers', () => {
  it('requests only allowed URLs with exactly the fixed headers and maps the chain to the expected outcome', async () => {
    await fc.assert(
      fc.asyncProperty(initialUrlArb, chainArb, async (initial, chain) => {
        const { response, calls, signal } = await runChain(initial, chain);
        const expected = expectedFor(initial, chain);

        // Requirement 8.2: every requested URL is an allowed pkg.go.dev HTTPS URL.
        for (const call of calls) {
          expect(isPkgGoDevHttpsUrl(call.url)).toBe(true);
        }
        expect(calls.map((c) => c.url)).toEqual(expected.requests);

        // Requirement 8.1: headers are exactly the fixed set, nothing else.
        for (const call of calls) {
          expect(call.headers).toBe(REQUEST_HEADERS);
          expect(call.headers).toEqual(LITERAL_HEADERS);
          expect(Object.keys(call.headers).map((k) => k.toLowerCase())).not.toContain('cookie');
          expect(Object.keys(call.headers).map((k) => k.toLowerCase())).not.toContain('authorization');
          expect(call.signal).toBe(signal);
          expect(call.maxBodyBytes).toBe(MAX_BODY_BYTES);
        }

        // Requirement 8.3: outcome mapping (never rejects; checked by reaching this line).
        expect(response).toEqual(expected.response);

        // At most MAX_REDIRECTS redirects are followed.
        expect(calls.length).toBeLessThanOrEqual(MAX_REDIRECTS + 1);
      }),
      { numRuns: RUNS },
    );
  });

  it('never requests a blocked redirect target and reports the redirect status and target host', async () => {
    const blockedArb = fc.oneof(blockedRedirectArb, malformedRedirectArb);
    await fc.assert(
      fc.asyncProperty(
        initialUrlArb,
        fc.array(allowedRedirectArb, { minLength: 0, maxLength: MAX_REDIRECTS }),
        blockedArb,
        async (initial, prefix, blocked) => {
          if (blocked.kind !== 'redirectBlocked') {
            throw new Error('generator produced a non-blocked hop');
          }
          const chain: Hop[] = [...prefix, blocked];
          const { response, calls } = await runChain(initial, chain);

          expect(calls).toHaveLength(prefix.length + 1);
          expect(calls.map((c) => c.url)).toEqual(expectedFor(initial, chain).requests);
          expect(response).toEqual({
            kind: 'failed',
            failure: { kind: 'redirectBlocked', status: blocked.status, targetHost: blocked.host },
          });
          // The blocked Location (resolved or raw) was never handed to the transport.
          for (const call of calls) {
            expect(call.url).not.toBe(blocked.location);
            expect(isPkgGoDevHttpsUrl(call.url)).toBe(true);
          }
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('follows exactly five redirects and fails with the http status on the sixth', async () => {
    await fc.assert(
      fc.asyncProperty(
        initialUrlArb,
        fc.array(allowedRedirectArb, { minLength: MAX_REDIRECTS + 1, maxLength: MAX_REDIRECTS + 4 }),
        async (initial, chain) => {
          const { response, calls } = await runChain(initial, chain);
          const sixth = chain[MAX_REDIRECTS];
          if (sixth === undefined || sixth.kind !== 'redirectAllowed') {
            throw new Error('generator produced a short chain');
          }
          expect(calls).toHaveLength(MAX_REDIRECTS + 1);
          expect(response).toEqual({ kind: 'failed', failure: { kind: 'http', status: sixth.status } });
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('refuses a non-allowed initial URL as unreachable without contacting the transport', async () => {
    await fc.assert(
      fc.asyncProperty(disallowedInitialUrlArb, chainArb, async (initial, chain) => {
        const { response, calls } = await runChain(initial, chain);
        expect(calls).toHaveLength(0);
        expect(response.kind).toBe('failed');
        if (response.kind === 'failed') {
          expect(response.failure.kind).toBe('unreachable');
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('resolves (never rejects) when the transport throws synchronously or rejects with arbitrary values', async () => {
    const thrownArb = fc.oneof(
      fc.string(),
      fc.constant(null),
      fc.constant(undefined),
      fc.integer(),
      fc.record({ code: fc.string({ minLength: 1, maxLength: 10 }) }),
      fc.record({ message: fc.string({ maxLength: 10 }) }),
    );
    await fc.assert(
      fc.asyncProperty(initialUrlArb, thrownArb, fc.boolean(), fc.boolean(), async (initial, thrown, sync, abort) => {
        const controller = new AbortController();
        const calls: string[] = [];
        const transport: HttpTransport = {
          get(url) {
            calls.push(url);
            if (abort) {
              controller.abort();
            }
            if (sync) {
              throw thrown;
            }
            return Promise.reject(thrown);
          },
        };
        const response = await new PkgGoDevSearchClient(transport).search(initial, controller.signal);
        expect(calls).toEqual([initial]);
        if (abort) {
          expect(response).toEqual({ kind: 'aborted' });
        } else {
          expect(response.kind).toBe('failed');
          if (response.kind === 'failed') {
            expect(response.failure.kind).toBe('unreachable');
          }
        }
      }),
      { numRuns: RUNS },
    );
  });
});
