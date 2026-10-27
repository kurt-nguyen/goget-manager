import * as https from 'node:https';

import type { SearchClient, SearchResponse } from '../core/searchController';
import { isPkgGoDevHttpsUrl } from '../core/searchQuery';

export interface RawHttpResponse {
  readonly status: number;
  readonly location?: string;
  /** UTF-8 decoded, at most `maxBodyBytes` bytes. */
  readonly body: string;
}

export interface HttpTransport {
  /** Rejects with the Node error on network failure, or an AbortError when aborted. */
  get(
    url: string,
    headers: Readonly<Record<string, string>>,
    signal: AbortSignal,
    maxBodyBytes: number
  ): Promise<RawHttpResponse>;
}

export const REQUEST_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  Accept: 'text/html',
  'Accept-Encoding': 'identity',
  'User-Agent': 'goget-manager-vscode',
});

export const MAX_BODY_BYTES = 5 * 1024 * 1024;
export const MAX_REDIRECTS = 5;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

function describeError(error: unknown): string {
  try {
    if (typeof error === 'object' && error !== null) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'string' && code !== '') {
        return code;
      }
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string' && message !== '') {
        return message;
      }
    }
    return String(error);
  } catch {
    return 'unknown error';
  }
}

export class PkgGoDevSearchClient implements SearchClient {
  constructor(private readonly transport: HttpTransport) {}

  async search(url: string, signal: AbortSignal): Promise<SearchResponse> {
    try {
      return await this.run(url, signal);
    } catch (error) {
      if (signal.aborted) {
        return { kind: 'aborted' };
      }
      return { kind: 'failed', failure: { kind: 'unreachable', reason: describeError(error) } };
    }
  }

  private async run(initialUrl: string, signal: AbortSignal): Promise<SearchResponse> {
    if (!isPkgGoDevHttpsUrl(initialUrl)) {
      return {
        kind: 'failed',
        failure: { kind: 'unreachable', reason: 'URL is not an HTTPS pkg.go.dev URL' },
      };
    }

    let current = initialUrl;
    let followed = 0;
    for (;;) {
      const response = await this.transport.get(current, REQUEST_HEADERS, signal, MAX_BODY_BYTES);
      const { status } = response;

      if (status >= 200 && status <= 299) {
        return { kind: 'ok', html: response.body };
      }

      if (!REDIRECT_STATUSES.has(status) || !response.location) {
        return { kind: 'failed', failure: { kind: 'http', status } };
      }

      let target: URL | undefined;
      try {
        target = new URL(response.location, current);
      } catch {
        target = undefined;
      }

      if (target === undefined || !isPkgGoDevHttpsUrl(target.href)) {
        return {
          kind: 'failed',
          failure: {
            kind: 'redirectBlocked',
            status,
            targetHost: target === undefined ? '(invalid URL)' : target.host,
          },
        };
      }

      if (followed >= MAX_REDIRECTS) {
        return { kind: 'failed', failure: { kind: 'http', status } };
      }

      followed++;
      current = target.href;
    }
  }
}

function createAbortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  (error as Error & { code?: string }).code = 'ABORT_ERR';
  return error;
}

/**
 * Plain `node:https` GET. No agent override (VS Code proxy settings apply) and
 * no redirect following; the caller applies the redirect policy.
 */
export const nodeHttpsTransport: HttpTransport = {
  get(url, headers, signal, maxBodyBytes) {
    return new Promise<RawHttpResponse>((resolve, reject) => {
      if (signal.aborted) {
        reject(createAbortError());
        return;
      }

      let settled = false;
      const succeed = (value: RawHttpResponse): void => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      const fail = (error: unknown): void => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };

      const req = https.request(url, { method: 'GET', headers: { ...headers }, signal });

      req.on('error', fail);
      req.on('response', (res) => {
        const status = res.statusCode ?? 0;
        const rawLocation = res.headers.location;
        const location = typeof rawLocation === 'string' && rawLocation !== '' ? rawLocation : undefined;
        const chunks: Buffer[] = [];
        let received = 0;
        let ended = false;

        const finish = (): void => {
          const body = Buffer.concat(chunks).subarray(0, maxBodyBytes).toString('utf8');
          succeed(location === undefined ? { status, body } : { status, location, body });
        };

        res.on('data', (chunk: Buffer) => {
          if (settled) {
            return;
          }
          chunks.push(chunk);
          received += chunk.length;
          if (received >= maxBodyBytes) {
            finish();
            req.destroy();
          }
        });
        res.on('end', () => {
          ended = true;
          finish();
        });
        res.on('error', fail);
        res.on('aborted', () => {
          if (!ended) {
            fail(Object.assign(new Error('Response aborted'), { code: 'ECONNRESET' }));
          }
        });
        res.on('close', () => {
          if (!ended) {
            fail(Object.assign(new Error('Connection closed before response ended'), { code: 'ECONNRESET' }));
          }
        });
      });

      req.end();
    });
  },
};
