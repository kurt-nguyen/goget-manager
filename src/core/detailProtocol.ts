import type { PackageDetail } from './packageDetail';

export interface DetailViewModel {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  /** Requested import path; empty when idle. */
  readonly path: string;
  /** Present for `ready` (and kept while `mainLoading` or an inline error is shown). */
  readonly detail?: PackageDetail;
  /** Currently shown GOOS (selected option value). */
  readonly goos?: string;
  readonly installed: boolean;
  /** A GOOS refetch is in progress. */
  readonly mainLoading: boolean;
  /** Page error (status `error`) or inline main error (status `ready`). */
  readonly error?: string;
  /** An Install or Uninstall of this package is running. */
  readonly busy?: 'install' | 'uninstall';
  /** The last Install/Uninstall failed with this message. */
  readonly actionError?: string;
}

export type HostToDetail =
  | { readonly type: 'state'; readonly state: DetailViewModel }
  | { readonly type: 'installed'; readonly installed: boolean }
  | {
      readonly type: 'action';
      readonly installed: boolean;
      readonly busy?: 'install' | 'uninstall';
      readonly error?: string;
    };

export type DetailToHost =
  | { readonly type: 'ready' }
  | { readonly type: 'changeGoos'; readonly goos: string }
  | { readonly type: 'openLink'; readonly url: string }
  | { readonly type: 'retry' }
  | { readonly type: 'install' }
  | { readonly type: 'uninstall' };

export const EMPTY_DETAIL_STATE: DetailViewModel = Object.freeze({
  status: 'idle',
  path: '',
  installed: false,
  mainLoading: false,
});

const GOOS_PATTERN = /^[a-z0-9]{1,16}$/u;
const MAX_URL_LENGTH = 2048;
const LINK_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:']);

/**
 * Validates an untrusted detail-webview message. Never throws.
 *
 * Returns a new object containing only the allowed keys, or `undefined` for
 * anything that is not a valid message.
 */
export function parseDetailMessage(value: unknown): DetailToHost | undefined {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    switch (record.type) {
      case 'ready':
        return { type: 'ready' };
      case 'retry':
        return { type: 'retry' };
      case 'install':
        return { type: 'install' };
      case 'uninstall':
        return { type: 'uninstall' };
      case 'changeGoos': {
        const goos = record.goos;
        if (typeof goos !== 'string' || !GOOS_PATTERN.test(goos)) {
          return undefined;
        }
        return { type: 'changeGoos', goos };
      }
      case 'openLink': {
        const url = record.url;
        if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL_LENGTH) {
          return undefined;
        }
        const parsed = new URL(url);
        if (!LINK_PROTOCOLS.has(parsed.protocol)) {
          return undefined;
        }
        return { type: 'openLink', url: parsed.href };
      }
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}
