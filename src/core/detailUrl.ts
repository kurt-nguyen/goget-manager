import { isPkgGoDevHttpsUrl, PKG_GO_DEV_HOST } from './searchQuery';

export type PackageDetailUrlResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: 'invalidPath' | 'invalidGoos' };

const MAX_PATH_LENGTH = 512;
const SEGMENT = /^[A-Za-z0-9._~+-]+$/u;
const GOOS = /^[a-z0-9]{1,16}$/u;

/** Import path made of non-empty `[A-Za-z0-9._~+-]` segments (no `.`/`..`), 1..512 chars. */
export function isValidImportPath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_LENGTH) {
    return false;
  }
  for (const segment of path.split('/')) {
    if (segment === '.' || segment === '..' || !SEGMENT.test(segment)) {
      return false;
    }
  }
  return true;
}

/** `https://pkg.go.dev/<path>` plus `?GOOS=<goos>` when given. */
export function packageDetailUrl(path: string, goos?: string): PackageDetailUrlResult {
  if (!isValidImportPath(path)) {
    return { ok: false, reason: 'invalidPath' };
  }
  if (goos !== undefined && !GOOS.test(goos)) {
    return { ok: false, reason: 'invalidGoos' };
  }
  const url = `https://${PKG_GO_DEV_HOST}/${path}${goos === undefined ? '' : `?GOOS=${goos}`}`;
  if (!isPkgGoDevHttpsUrl(url)) {
    return { ok: false, reason: 'invalidPath' };
  }
  return { ok: true, url };
}
