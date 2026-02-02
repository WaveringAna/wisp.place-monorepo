import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { parseRedirectsFile, type RedirectRule } from '@wispplace/fs-utils';

// Re-export everything from the shared package
export {
  parseRedirectsFile,
  matchRedirectRule,
  parseCookies,
  parseQueryString,
  type RedirectRule,
  type RedirectMatch,
  type MatchRedirectContext,
} from '@wispplace/fs-utils';

/**
 * Load redirect rules from a cached site
 */
export async function loadRedirectRules(did: string, rkey: string): Promise<RedirectRule[]> {
  const CACHE_DIR = process.env.CACHE_DIR || './cache/sites';
  const redirectsPath = `${CACHE_DIR}/${did}/${rkey}/_redirects`;

  if (!existsSync(redirectsPath)) {
    return [];
  }

  try {
    const content = await readFile(redirectsPath, 'utf-8');
    return parseRedirectsFile(content);
  } catch (err) {
    console.error('Failed to load _redirects file', err);
    return [];
  }
}
