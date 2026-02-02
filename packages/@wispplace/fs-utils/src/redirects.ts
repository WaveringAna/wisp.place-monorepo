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

/**
 * Parse a _redirects file into an array of redirect rules
 */
export function parseRedirectsFile(content: string): RedirectRule[] {
  const lines = content.split('\n');
  const rules: RedirectRule[] = [];

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const lineRaw = lines[lineNum];
    if (!lineRaw) continue;

    const line = lineRaw.trim();

    if (!line || line.startsWith('#')) {
      continue;
    }

    if (rules.length >= MAX_REDIRECT_RULES) {
      break;
    }

    try {
      const rule = parseRedirectLine(line);
      if (rule && rule.fromPattern) {
        rules.push(rule);
      }
    } catch {
      // Skip invalid lines
    }
  }

  return rules;
}

/**
 * Parse a single redirect rule line
 * Format: /from [query_params] /to [status] [conditions]
 */
function parseRedirectLine(line: string): RedirectRule | null {
  const parts = line.split(/\s+/);

  if (parts.length < 2) {
    return null;
  }

  let idx = 0;
  const from = parts[idx++];

  if (!from) {
    return null;
  }

  let status = 301;
  let force = false;
  const conditions: NonNullable<RedirectRule['conditions']> = {};
  const queryParams: Record<string, string> = {};

  // Parse query parameters that come before the destination path
  while (idx < parts.length) {
    const part = parts[idx];
    if (!part) {
      idx++;
      continue;
    }

    if (part.startsWith('/') || part.startsWith('http://') || part.startsWith('https://')) {
      break;
    }

    if (part.includes('=')) {
      const splitIndex = part.indexOf('=');
      const key = part.slice(0, splitIndex);
      const value = part.slice(splitIndex + 1);

      if (key && value) {
        queryParams[key] = value;
      }
      idx++;
    } else {
      break;
    }
  }

  if (idx >= parts.length) {
    return null;
  }

  const to = parts[idx++];
  if (!to) {
    return null;
  }

  // Parse remaining parts for status code and conditions
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

/**
 * Convert a path pattern with placeholders and splats to a regex
 * Examples:
 *   /blog/:year/:month/:day -> captures year, month, day
 *   /news/* -> captures splat
 */
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

  return {
    pattern: new RegExp(regexStr),
    params,
  };
}

export interface MatchRedirectContext {
  queryParams?: Record<string, string>;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
}

/**
 * Match a request path against redirect rules with loop detection
 */
export function matchRedirectRule(
  requestPath: string,
  rules: RedirectRule[],
  context?: MatchRedirectContext,
  visitedPaths: Set<string> = new Set()
): RedirectMatch | null {
  let normalizedPath = requestPath.startsWith('/') ? requestPath : `/${requestPath}`;

  if (visitedPaths.has(normalizedPath)) {
    return null;
  }

  visitedPaths.add(normalizedPath);

  if (visitedPaths.size > 10) {
    return null;
  }

  for (const rule of rules) {
    // Check query parameter conditions first
    if (rule.queryParams) {
      if (!context?.queryParams) {
        continue;
      }

      const queryMatches = Object.entries(rule.queryParams).every(([key, expectedValue]) => {
        const actualValue = context.queryParams?.[key];

        if (actualValue === undefined) {
          return false;
        }

        if (expectedValue && !expectedValue.startsWith(':')) {
          return actualValue === expectedValue;
        }

        return true;
      });

      if (!queryMatches) {
        continue;
      }
    }

    // Check conditional redirects (country, language, role, cookie)
    if (rule.conditions) {
      if (rule.conditions.country && context?.headers) {
        const cfCountry = context.headers['cf-ipcountry'];
        const xCountry = context.headers['x-country'];
        const country = cfCountry?.toLowerCase() || xCountry?.toLowerCase();
        if (!country || !rule.conditions.country.includes(country)) {
          continue;
        }
      }

      if (rule.conditions.language && context?.headers) {
        const acceptLang = context.headers['accept-language'];
        if (!acceptLang) {
          continue;
        }
        const langs = acceptLang
          .split(',')
          .map(l => {
            const langPart = l.split(';')[0];
            return langPart ? langPart.trim().toLowerCase() : '';
          })
          .filter(l => l !== '');
        const hasMatch = rule.conditions.language.some(lang =>
          langs.some(l => l === lang || l.startsWith(lang + '-'))
        );
        if (!hasMatch) {
          continue;
        }
      }

      if (rule.conditions.cookie && context?.cookies) {
        const hasCookie = rule.conditions.cookie.some(
          cookieName => context.cookies && cookieName in context.cookies
        );
        if (!hasCookie) {
          continue;
        }
      }

      // Role-based redirects would need JWT verification - skip for now
      if (rule.conditions.role) {
        continue;
      }
    }

    const match = rule.fromPattern?.exec(normalizedPath);
    if (!match) {
      continue;
    }

    let targetPath = rule.to;

    // Replace captured parameters
    if (rule.fromParams && match.length > 1) {
      for (let i = 0; i < rule.fromParams.length; i++) {
        const paramName = rule.fromParams[i];
        const paramValue = match[i + 1];

        if (!paramName || !paramValue) continue;

        const encodedValue = encodeURIComponent(paramValue);

        if (paramName === 'splat') {
          const splatValue = encodedValue.replace(/%2F/g, '/');
          targetPath = targetPath.replace(':splat', splatValue);
        } else {
          targetPath = targetPath.replace(`:${paramName}`, encodedValue);
        }
      }
    }

    // Handle query parameter replacements
    if (rule.queryParams && context?.queryParams) {
      for (const [key, placeholder] of Object.entries(rule.queryParams)) {
        const actualValue = context.queryParams[key];
        if (actualValue && placeholder && placeholder.startsWith(':')) {
          const paramName = placeholder.slice(1);
          if (paramName) {
            const encodedValue = encodeURIComponent(actualValue);
            targetPath = targetPath.replace(`:${paramName}`, encodedValue);
          }
        }
      }
    }

    // Preserve query string for 200, 301, 302 redirects (unless target already has one)
    if ([200, 301, 302].includes(rule.status) && context?.queryParams && !targetPath.includes('?')) {
      const queryString = Object.entries(context.queryParams)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
      if (queryString) {
        targetPath += `?${queryString}`;
      }
    }

    return {
      rule,
      targetPath,
      status: rule.status,
    };
  }

  return null;
}

/**
 * Parse cookies from Cookie header
 */
export function parseCookies(cookieHeader?: string): Record<string, string> {
  if (!cookieHeader) return {};

  const cookies: Record<string, string> = {};
  const parts = cookieHeader.split(';');

  for (const part of parts) {
    const [key, ...valueParts] = part.split('=');
    if (key && valueParts.length > 0) {
      cookies[key.trim()] = valueParts.join('=').trim();
    }
  }

  return cookies;
}

/**
 * Parse query string into object
 */
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
