import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Spying on the `node:https` namespace fails under vitest ("Module namespace is not
// configurable in ESM"), so the module is replaced with a factory instead.
const httpsRequest = vi.hoisted(() => vi.fn());
vi.mock('node:https', () => ({ request: httpsRequest, default: { request: httpsRequest } }));

import {
  MAX_BODY_BYTES,
  MAX_REDIRECTS,
  PkgGoDevSearchClient,
  REQUEST_HEADERS,
  nodeHttpsTransport,
  type HttpTransport,
  type RawHttpResponse,
} from '../../src/vscode/searchClient';

const SEARCH_URL = 'https://pkg.go.dev/search?q=mongodb&m=package';

type Step = RawHttpResponse | Error;

function scriptedTransport(steps: Step[]): HttpTransport & { urls: string[] } {
  const urls: string[] = [];
  let i = 0;
  return {
    urls,
    get(url) {
      urls.push(url);
      const step = steps[Math.min(i++, steps.length - 1)] as Step;
      return step instanceof Error ? Promise.reject(step) : Promise.resolve(step);
    },
  };
}

function nodeError(code: string): Error {
  return Object.assign(new Error(`connect ${code}`), { code });
}

describe('PkgGoDevSearchClient', () => {
  it('returns the body for a 2xx response', async () => {
    const transport = scriptedTransport([{ status: 200, body: '<html></html>' }]);
    const result = await new PkgGoDevSearchClient(transport).search(SEARCH_URL, new AbortController().signal);
    expect(result).toEqual({ kind: 'ok', html: '<html></html>' });
    expect(transport.urls).toEqual([SEARCH_URL]);
  });

  it('maps a redirect status without Location to an http failure', async () => {
    const transport = scriptedTransport([{ status: 302, body: '' }]);
    const result = await new PkgGoDevSearchClient(transport).search(SEARCH_URL, new AbortController().signal);
    expect(result).toEqual({ kind: 'failed', failure: { kind: 'http', status: 302 } });
    expect(transport.urls).toHaveLength(1);
  });

  it('maps a non-redirect, non-2xx status to an http failure', async () => {
    const transport = scriptedTransport([{ status: 503, body: '' }]);
    const result = await new PkgGoDevSearchClient(transport).search(SEARCH_URL, new AbortController().signal);
    expect(result).toEqual({ kind: 'failed', failure: { kind: 'http', status: 503 } });
  });

  it('follows five same-host redirects and succeeds', async () => {
    const steps: Step[] = [];
    for (let i = 0; i < MAX_REDIRECTS; i++) {
      steps.push({ status: 301, location: `/hop${i}`, body: '' });
    }
    steps.push({ status: 200, body: 'done' });
    const transport = scriptedTransport(steps);
    const result = await new PkgGoDevSearchClient(transport).search(SEARCH_URL, new AbortController().signal);
    expect(result).toEqual({ kind: 'ok', html: 'done' });
    expect(transport.urls).toHaveLength(MAX_REDIRECTS + 1);
    expect(transport.urls[1]).toBe('https://pkg.go.dev/hop0');
  });

  it('fails with http and the last status after six same-host redirects', async () => {
    const transport = scriptedTransport([
      { status: 301, location: '/a', body: '' },
      { status: 302, location: '/b', body: '' },
      { status: 303, location: '/c', body: '' },
      { status: 307, location: '/d', body: '' },
      { status: 308, location: '/e', body: '' },
      { status: 301, location: '/f', body: '' },
      { status: 200, body: 'never reached' },
    ]);
    const result = await new PkgGoDevSearchClient(transport).search(SEARCH_URL, new AbortController().signal);
    expect(result).toEqual({ kind: 'failed', failure: { kind: 'http', status: 301 } });
    expect(transport.urls).toHaveLength(MAX_REDIRECTS + 1);
  });

  it('blocks a redirect to another host and reports status and host', async () => {
    const transport = scriptedTransport([{ status: 302, location: 'https://evil.example/x', body: '' }]);
    const result = await new PkgGoDevSearchClient(transport).search(SEARCH_URL, new AbortController().signal);
    expect(result).toEqual({
      kind: 'failed',
      failure: { kind: 'redirectBlocked', status: 302, targetHost: 'evil.example' },
    });
    expect(transport.urls).toHaveLength(1);
  });

  it('refuses a non pkg.go.dev initial URL without sending', async () => {
    const transport = scriptedTransport([{ status: 200, body: '' }]);
    const result = await new PkgGoDevSearchClient(transport).search(
      'http://pkg.go.dev/search?q=x',
      new AbortController().signal
    );
    expect(result.kind).toBe('failed');
    expect(transport.urls).toHaveLength(0);
  });

  it('returns aborted when the signal is aborted and the transport rejects', async () => {
    const controller = new AbortController();
    const transport: HttpTransport = {
      get: () => {
        controller.abort();
        return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      },
    };
    const result = await new PkgGoDevSearchClient(transport).search(SEARCH_URL, controller.signal);
    expect(result).toEqual({ kind: 'aborted' });
  });

  it('returns aborted for an already aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const transport: HttpTransport = {
      get: () => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    };
    const result = await new PkgGoDevSearchClient(transport).search(SEARCH_URL, controller.signal);
    expect(result).toEqual({ kind: 'aborted' });
  });

  it.each(['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET'])('maps %s to unreachable with the code', async (code) => {
    const transport = scriptedTransport([nodeError(code)]);
    const result = await new PkgGoDevSearchClient(transport).search(SEARCH_URL, new AbortController().signal);
    expect(result).toEqual({ kind: 'failed', failure: { kind: 'unreachable', reason: code } });
  });

  it('falls back to the error message when there is no code', async () => {
    const transport = scriptedTransport([new Error('boom')]);
    const result = await new PkgGoDevSearchClient(transport).search(SEARCH_URL, new AbortController().signal);
    expect(result).toEqual({ kind: 'failed', failure: { kind: 'unreachable', reason: 'boom' } });
  });

  it('passes the fixed headers and body cap to the transport', async () => {
    const get = vi.fn().mockResolvedValue({ status: 200, body: '' });
    await new PkgGoDevSearchClient({ get }).search(SEARCH_URL, new AbortController().signal);
    expect(get).toHaveBeenCalledWith(SEARCH_URL, REQUEST_HEADERS, expect.any(AbortSignal), MAX_BODY_BYTES);
  });
});

class FakeRequest extends EventEmitter {
  ended = false;
  destroyed = false;
  end(): this {
    this.ended = true;
    return this;
  }
  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

class FakeResponse extends EventEmitter {
  constructor(
    readonly statusCode: number,
    readonly headers: Record<string, string | string[] | undefined> = {}
  ) {
    super();
  }
}

describe('nodeHttpsTransport', () => {
  afterEach(() => {
    httpsRequest.mockReset();
  });

  function stubRequest(): { request: FakeRequest; spy: typeof httpsRequest } {
    const request = new FakeRequest();
    httpsRequest.mockReset();
    httpsRequest.mockReturnValue(request);
    return { request, spy: httpsRequest };
  }

  it('sends a plain GET with the fixed headers, the signal, and no redirect or agent option', () => {
    const { request, spy } = stubRequest();
    const signal = new AbortController().signal;
    void nodeHttpsTransport.get(SEARCH_URL, REQUEST_HEADERS, signal, MAX_BODY_BYTES).catch(() => undefined);

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, options] = spy.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(url).toBe(SEARCH_URL);
    expect(options.method).toBe('GET');
    expect(options.headers).toEqual(REQUEST_HEADERS);
    expect(options.signal).toBe(signal);
    expect(options).not.toHaveProperty('maxRedirects');
    expect(options).not.toHaveProperty('followRedirects');
    expect(options).not.toHaveProperty('agent');
    expect(request.ended).toBe(true);
  });

  it('resolves with status, location, and the decoded body', async () => {
    const { request } = stubRequest();
    const promise = nodeHttpsTransport.get(SEARCH_URL, REQUEST_HEADERS, new AbortController().signal, 1024);
    const res = new FakeResponse(302, { location: '/next' });
    request.emit('response', res);
    res.emit('data', Buffer.from('héllo ', 'utf8'));
    res.emit('data', Buffer.from('wörld', 'utf8'));
    res.emit('end');
    await expect(promise).resolves.toEqual({ status: 302, location: '/next', body: 'héllo wörld' });
  });

  it('omits location when the header is absent', async () => {
    const { request } = stubRequest();
    const promise = nodeHttpsTransport.get(SEARCH_URL, REQUEST_HEADERS, new AbortController().signal, 1024);
    const res = new FakeResponse(200);
    request.emit('response', res);
    res.emit('end');
    const result = await promise;
    expect(result).toEqual({ status: 200, body: '' });
    expect(result).not.toHaveProperty('location');
  });

  it('caps the body at maxBodyBytes and destroys the request', async () => {
    const { request } = stubRequest();
    const promise = nodeHttpsTransport.get(SEARCH_URL, REQUEST_HEADERS, new AbortController().signal, MAX_BODY_BYTES);
    const res = new FakeResponse(200);
    request.emit('response', res);
    const chunk = Buffer.alloc(MAX_BODY_BYTES - 10, 'a');
    res.emit('data', chunk);
    expect(request.destroyed).toBe(false);
    res.emit('data', Buffer.alloc(100, 'b'));
    expect(request.destroyed).toBe(true);
    // Late events after the cap must not change the outcome.
    res.emit('data', Buffer.alloc(100, 'c'));
    res.emit('close');
    const result = await promise;
    expect(result.status).toBe(200);
    expect(Buffer.byteLength(result.body, 'utf8')).toBe(MAX_BODY_BYTES);
    expect(result.body.endsWith('a' + 'b'.repeat(10))).toBe(true);
    expect(result.body).not.toContain('c');
  });

  it('rejects when the response closes before end', async () => {
    const { request } = stubRequest();
    const promise = nodeHttpsTransport.get(SEARCH_URL, REQUEST_HEADERS, new AbortController().signal, 1024);
    const res = new FakeResponse(200);
    request.emit('response', res);
    res.emit('data', Buffer.from('partial'));
    res.emit('close');
    await expect(promise).rejects.toMatchObject({ code: 'ECONNRESET' });
  });

  it('does not reject on close after end', async () => {
    const { request } = stubRequest();
    const promise = nodeHttpsTransport.get(SEARCH_URL, REQUEST_HEADERS, new AbortController().signal, 1024);
    const res = new FakeResponse(200);
    request.emit('response', res);
    res.emit('data', Buffer.from('ok'));
    res.emit('end');
    res.emit('close');
    await expect(promise).resolves.toEqual({ status: 200, body: 'ok' });
  });

  it('rejects when the response emits aborted before end', async () => {
    const { request } = stubRequest();
    const promise = nodeHttpsTransport.get(SEARCH_URL, REQUEST_HEADERS, new AbortController().signal, 1024);
    const res = new FakeResponse(200);
    request.emit('response', res);
    res.emit('aborted');
    await expect(promise).rejects.toMatchObject({ code: 'ECONNRESET' });
  });

  it('rejects with the request error', async () => {
    const { request } = stubRequest();
    const promise = nodeHttpsTransport.get(SEARCH_URL, REQUEST_HEADERS, new AbortController().signal, 1024);
    request.emit('error', nodeError('ENOTFOUND'));
    await expect(promise).rejects.toMatchObject({ code: 'ENOTFOUND' });
  });

  it('rejects with the response error', async () => {
    const { request } = stubRequest();
    const promise = nodeHttpsTransport.get(SEARCH_URL, REQUEST_HEADERS, new AbortController().signal, 1024);
    const res = new FakeResponse(200);
    request.emit('response', res);
    res.emit('error', nodeError('ECONNRESET'));
    await expect(promise).rejects.toMatchObject({ code: 'ECONNRESET' });
  });

  it('rejects without calling https.request when the signal is already aborted', async () => {
    const { spy } = stubRequest();
    const controller = new AbortController();
    controller.abort();
    await expect(
      nodeHttpsTransport.get(SEARCH_URL, REQUEST_HEADERS, controller.signal, 1024)
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects when the request errors with an AbortError during the response', async () => {
    const { request } = stubRequest();
    const controller = new AbortController();
    const promise = nodeHttpsTransport.get(SEARCH_URL, REQUEST_HEADERS, controller.signal, 1024);
    const res = new FakeResponse(200);
    request.emit('response', res);
    res.emit('data', Buffer.from('part'));
    controller.abort();
    // Node emits an AbortError on the request, then closes the response.
    request.emit('error', Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    res.emit('close');
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('lets PkgGoDevSearchClient report aborted when aborted during the response', async () => {
    const { request } = stubRequest();
    const controller = new AbortController();
    const promise = new PkgGoDevSearchClient(nodeHttpsTransport).search(SEARCH_URL, controller.signal);
    const res = new FakeResponse(200);
    request.emit('response', res);
    controller.abort();
    res.emit('close');
    await expect(promise).resolves.toEqual({ kind: 'aborted' });
  });
});
