import { readFile } from 'fs/promises';
import { existsSync } from 'fs';

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
  // For pattern matching
  fromPattern?: RegExp;
  fromParams?: string[]; // Named parameters from the pattern
  queryParams?: Record<string, string>; // Expected query parameters
}

export interface RedirectMatch {
  rule: RedirectRule;
  targetPath: string;
  status: number;
}

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
    
    // Skip empty lines and comments
    if (!line || line.startsWith('#')) {
      continue;
    }

    try {
      const rule = parseRedirectLine(line);
      if (rule && rule.fromPattern) {
        rules.push(rule);
      }
    } catch (err) {
      console.warn(`Failed to parse redirect rule on line ${lineNum + 1}: ${line}`, err);
    }
  }

  return rules;
}

/**
 * Parse a single redirect rule line
 * Format: /from [query_params] /to [status] [conditions]
 */
function parseRedirectLine(line: string): RedirectRule | null {
  // Split by whitespace, but respect quoted strings (though not commonly used)
  const parts = line.split(/\s+/);
  
  if (parts.length < 2) {
    return null;
  }

  let idx = 0;
  const from = parts[idx++];
  
  if (!from) {
    return null;
  }
  
  let status = 301; // Default status
  let force = false;
  const conditions: NonNullable<RedirectRule['conditions']> = {};
  const queryParams: Record<string, string> = {};
  
  // Parse query parameters that come before the destination path
  // They look like: key=:value (and don't start with /)
  while (idx < parts.length) {
    const part = parts[idx];
    if (!part) {
      idx++;
      continue;
    }
    
    // If it starts with / or http, it's the destination path
    if (part.startsWith('/') || part.startsWith('http://') || part.startsWith('https://')) {
      break;
    }
    
    // If it contains = and comes before the destination, it's a query param
    if (part.includes('=')) {
      const splitIndex = part.indexOf('=');
      const key = part.slice(0, splitIndex);
      const value = part.slice(splitIndex + 1);
      
      if (key && value) {
        queryParams[key] = value;
      }
      idx++;
    } else {
      // Not a query param, must be destination or something else
      break;
    }
  }
  
  // Next part should be the destination
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
    
    // Check for status code (with optional ! for force)
    if (/^\d+!?$/.test(part)) {
      if (part.endsWith('!')) {
        force = true;
        status = parseInt(part.slice(0, -1));
      } else {
        status = parseInt(part);
      }
      continue;
    }

    // Check for condition parameters (Country=, Language=, Role=, Cookie=)
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

  // Parse the 'from' pattern
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
  
  // Split by query string if present
  const pathPart = pattern.split('?')[0] || pattern;
  
  // Escape special regex characters except * and :
  let escaped = pathPart.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  
  // Replace :param with named capture groups
  escaped = escaped.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (match, paramName) => {
    params.push(paramName);
    // Match path segment (everything except / and ?)
    return '([^/?]+)';
  });
  
  // Replace * with splat capture (matches everything including /)
  if (escaped.includes('*')) {
    escaped = escaped.replace(/\*/g, '(.*)');
    params.push('splat');
  }
  
  regexStr += escaped;
  
  // Make trailing slash optional
  if (!regexStr.endsWith('.*')) {
    regexStr += '/?';
  }
  
  regexStr += '$';
  
  return {
    pattern: new RegExp(regexStr),
    params,
  };
}

/**
 * Match a request path against redirect rules
 */
export function matchRedirectRule(
  requestPath: string,
  rules: RedirectRule[],
  context?: {
    queryParams?: Record<string, string>;
    headers?: Record<string, string>;
    cookies?: Record<string, string>;
  }
): RedirectMatch | null {
  // Normalize path: ensure leading slash, remove trailing slash (except for root)
  let normalizedPath = requestPath.startsWith('/') ? requestPath : `/${requestPath}`;
  
  for (const rule of rules) {
    // Check query parameter conditions first (if any)
    if (rule.queryParams) {
      // If rule requires query params but none provided, skip this rule
      if (!context?.queryParams) {
        continue;
      }
      
      const queryMatches = Object.entries(rule.queryParams).every(([key, value]) => {
        const actualValue = context.queryParams?.[key];
        return actualValue !== undefined;
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
        const country = (cfCountry?.toLowerCase() || xCountry?.toLowerCase());
        if (!country || !rule.conditions.country.includes(country)) {
          continue;
        }
      }

      if (rule.conditions.language && context?.headers) {
        const acceptLang = context.headers['accept-language'];
        if (!acceptLang) {
          continue;
        }
        // Parse accept-language header (simplified)
        const langs = acceptLang.split(',').map(l => {
          const langPart = l.split(';')[0];
          return langPart ? langPart.trim().toLowerCase() : '';
        }).filter(l => l !== '');
        const hasMatch = rule.conditions.language.some(lang => 
          langs.some(l => l === lang || l.startsWith(lang + '-'))
        );
        if (!hasMatch) {
          continue;
        }
      }

      if (rule.conditions.cookie && context?.cookies) {
        const hasCookie = rule.conditions.cookie.some(cookieName => 
          context.cookies && cookieName in context.cookies
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

    // Match the path pattern
    const match = rule.fromPattern?.exec(normalizedPath);
    if (!match) {
      continue;
    }

    // Build the target path by replacing placeholders
    let targetPath = rule.to;
    
    // Replace captured parameters
    if (rule.fromParams && match.length > 1) {
      for (let i = 0; i < rule.fromParams.length; i++) {
        const paramName = rule.fromParams[i];
        const paramValue = match[i + 1];
        
        if (!paramName || !paramValue) continue;
        
        if (paramName === 'splat') {
          targetPath = targetPath.replace(':splat', paramValue);
        } else {
          targetPath = targetPath.replace(`:${paramName}`, paramValue);
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
            targetPath = targetPath.replace(`:${paramName}`, actualValue);
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

