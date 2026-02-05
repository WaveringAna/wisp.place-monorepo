import { parseRedirectsFile, type RedirectRule } from '@wispplace/fs-utils';
import { storage } from './storage';

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
  const key = `${did}/${rkey}/_redirects`;
  try {
    const data = await storage.get(key);
    if (!data) return [];
    const content = new TextDecoder().decode(data as Uint8Array);
    return parseRedirectsFile(content);
  } catch (err) {
    console.error('Failed to load _redirects file', err);
    return [];
  }
}
