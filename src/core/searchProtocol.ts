import type { PackageResult } from './resultsParser';
import { clampSearchText } from './searchText';

export interface SearchViewModel {
  readonly results: readonly PackageResult[];
  /** Empty string when there is no Status_Message. */
  readonly status: string;
  readonly loading: boolean;
  /** Increments whenever `results` is replaced. */
  readonly resultsVersion: number;
}

export type WebviewToHost =
  | { readonly type: 'ready' }
  | { readonly type: 'query'; readonly text: string }
  | { readonly type: 'submit'; readonly text: string }
  | { readonly type: 'open'; readonly resultsVersion: number; readonly index: number };

export type HostToWebview = { readonly type: 'state'; readonly state: SearchViewModel };

export const EMPTY_VIEW_MODEL: SearchViewModel = Object.freeze({
  results: Object.freeze([]) as readonly PackageResult[],
  status: '',
  loading: false,
  resultsVersion: 0,
});

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Validates an untrusted webview message. Never throws.
 *
 * Returns a new object containing only the allowed keys, with `text` clamped
 * to 256 code points, or `undefined` for anything that is not a valid message.
 */
export function parseWebviewMessage(value: unknown): WebviewToHost | undefined {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    const type = record.type;

    switch (type) {
      case 'ready':
        return { type: 'ready' };
      case 'query':
      case 'submit': {
        const text = record.text;
        if (typeof text !== 'string') {
          return undefined;
        }
        return { type, text: clampSearchText(text) };
      }
      case 'open': {
        const resultsVersion = record.resultsVersion;
        const index = record.index;
        if (!isNonNegativeInteger(resultsVersion) || !isNonNegativeInteger(index)) {
          return undefined;
        }
        return { type: 'open', resultsVersion, index };
      }
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}
