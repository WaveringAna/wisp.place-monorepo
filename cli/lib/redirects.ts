/**
 * _redirects file parsing - adapted from hosting-service
 */

export interface RedirectRule {
  from: string;
  to: string;
  status: number;
  force: boolean;
  conditions?: {
    country?: string[];
    language?: string[];
    role?: string[];
    cookie?: string[];
  };
  fromPattern?: RegExp;
  fromParams?: string[];
  queryParams?: Record<string, string>;
}

export interface RedirectMatch {
  rule: RedirectRule;
  targetPath: string;
  status: number;
}

const MAX_REDIRECT_RULES = 1000;

export function parseRedirectsFile(content: string): RedirectRule[] {
  const lines = content.split('\n');
  const rules: RedirectRule[] = [];

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const lineRaw = lines[lineNum];
    if (!lineRaw) continue;

    const line = lineRaw.trim();
    if (!line || line.startsWith('#')) continue;
    if (rules.length >= MAX_REDIRECT_RULES) break;

    try {
      const rule = parseRedirectLine(line);
      if (rule?.fromPattern) {
        rules.push(rule);
      }
    } catch {
      // Skip invalid lines
    }
  }

  return rules;
}

function parseRedirectLine(line: string): RedirectRule | null {
  const parts = line.split(/\s+/);
  if (parts.length < 2) return null;

  let idx = 0;
  const from = parts[idx++];
  if (!from) return null;

  let status = 301;
  let force = false;
  const conditions: NonNullable<RedirectRule['conditions']> = {};
  const queryParams: Record<string, string> = {};

  // Parse query parameters before destination
  while (idx < parts.length) {
    const part = parts[idx];
    if (!part) { idx++; continue; }
    if (part.startsWith('/') || part.startsWith('http://') || part.startsWith('https://')) break;
    if (part.includes('=')) {
      const splitIndex = part.indexOf('=');
      const key = part.slice(0, splitIndex);
      const value = part.slice(splitIndex + 1);
      if (key && value) queryParams[key] = value;
      idx++;
    } else {
      break;
    }
  }

  if (idx >= parts.length) return null;
  const to = parts[idx++];
  if (!to) return null;

  // Parse status and conditions
  for (let i = idx; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;

    if (/^\d+!?$/.test(part)) {
      if (part.endsWith('!')) {
        force = true;
        status = parseInt(part.slice(0, -1));
      } else {
        status = parseInt(part);
      }
      continue;
    }

    if (part.includes('=')) {
      const splitIndex = part.indexOf('=');
      const key = part.slice(0, splitIndex);
      const value = part.slice(splitIndex + 1);
      if (!key || !value) continue;

      const keyLower = key.toLowerCase();
      if (keyLower === 'country') {
        conditions.country = value.split(',').map(v => v.trim().toLowerCase());
      } else if (keyLower === 'language') {
        conditions.language = value.split(',').map(v => v.trim().toLowerCase());
      } else if (keyLower === 'role') {
        conditions.role = value.split(',').map(v => v.trim());
      } else if (keyLower === 'cookie') {
        conditions.cookie = value.split(',').map(v => v.trim().toLowerCase());
      }
    }
  }

  const { pattern, params } = convertPathToRegex(from);

  return {
    from,
    to,
    status,
    force,
    conditions: Object.keys(conditions).length > 0 ? conditions : undefined,
    queryParams: Object.keys(queryParams).length > 0 ? queryParams : undefined,
    fromPattern: pattern,
    fromParams: params,
  };
}

function convertPathToRegex(pattern: string): { pattern: RegExp; params: string[] } {
  const params: string[] = [];
  let regexStr = '^';

  const pathPart = pattern.split('?')[0] || pattern;
  let escaped = pathPart.replace(/[.+^${}()|[\]\\]/g, '\\$&');

  escaped = escaped.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_match, paramName) => {
    params.push(paramName);
    return '([^/?]+)';
  });

  if (escaped.includes('*')) {
    escaped = escaped.replace(/\*/g, '(.*)');
    params.push('splat');
  }

  regexStr += escaped;
  if (!regexStr.endsWith('.*')) {
    regexStr += '/?';
  }
  regexStr += '$';

  return { pattern: new RegExp(regexStr), params };
}

export function matchRedirectRule(
  requestPath: string,
  rules: RedirectRule[],
  context?: {
    queryParams?: Record<string, string>;
    headers?: Record<string, string>;
    cookies?: Record<string, string>;
  },
  visitedPaths: Set<string> = new Set()
): RedirectMatch | null {
  let normalizedPath = requestPath.startsWith('/') ? requestPath : `/${requestPath}`;

  if (visitedPaths.has(normalizedPath)) return null;
  visitedPaths.add(normalizedPath);
  if (visitedPaths.size > 10) return null;

  for (const rule of rules) {
    // Check query params
    if (rule.queryParams) {
      if (!context?.queryParams) continue;
      const queryMatches = Object.entries(rule.queryParams).every(([key, expectedValue]) => {
        const actualValue = context.queryParams?.[key];
        if (actualValue === undefined) return false;
        if (expectedValue && !expectedValue.startsWith(':')) {
          return actualValue === expectedValue;
        }
        return true;
      });
      if (!queryMatches) continue;
    }

    // Check conditions
    if (rule.conditions) {
      if (rule.conditions.country && context?.headers) {
        const country = context.headers['cf-ipcountry']?.toLowerCase() || context.headers['x-country']?.toLowerCase();
        if (!country || !rule.conditions.country.includes(country)) continue;
      }
      if (rule.conditions.language && context?.headers) {
        const acceptLang = context.headers['accept-language'];
        if (!acceptLang) continue;
        const langs = acceptLang.split(',').map(l => l.split(';')[0]?.trim().toLowerCase() || '').filter(Boolean);
        const hasMatch = rule.conditions.language.some(lang => langs.some(l => l === lang || l.startsWith(lang + '-')));
        if (!hasMatch) continue;
      }
      if (rule.conditions.cookie && context?.cookies) {
        const hasCookie = rule.conditions.cookie.some(cookieName => context.cookies && cookieName in context.cookies);
        if (!hasCookie) continue;
      }
      if (rule.conditions.role) continue;
    }

    const match = rule.fromPattern?.exec(normalizedPath);
    if (!match) continue;

    let targetPath = rule.to;

    if (rule.fromParams && match.length > 1) {
      for (let i = 0; i < rule.fromParams.length; i++) {
        const paramName = rule.fromParams[i];
        const paramValue = match[i + 1];
        if (!paramName || !paramValue) continue;

        const encodedValue = encodeURIComponent(paramValue);
        if (paramName === 'splat') {
          targetPath = targetPath.replace(':splat', encodedValue.replace(/%2F/g, '/'));
        } else {
          targetPath = targetPath.replace(`:${paramName}`, encodedValue);
        }
      }
    }

    if (rule.queryParams && context?.queryParams) {
      for (const [key, placeholder] of Object.entries(rule.queryParams)) {
        const actualValue = context.queryParams[key];
        if (actualValue && placeholder?.startsWith(':')) {
          const paramName = placeholder.slice(1);
          if (paramName) {
            targetPath = targetPath.replace(`:${paramName}`, encodeURIComponent(actualValue));
          }
        }
      }
    }

    return { rule, targetPath, status: rule.status };
  }

  return null;
}

export function parseCookies(cookieHeader?: string): Record<string, string> {
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const [key, ...valueParts] = part.split('=');
    if (key && valueParts.length > 0) {
      cookies[key.trim()] = valueParts.join('=').trim();
    }
  }
  return cookies;
}

export function parseQueryString(url: string): Record<string, string> {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) return {};
  const queryString = url.slice(queryStart + 1);
  const params: Record<string, string> = {};
  for (const pair of queryString.split('&')) {
    const [key, value] = pair.split('=');
    if (key) {
      params[decodeURIComponent(key)] = value ? decodeURIComponent(value) : '';
    }
  }
  return params;
}
