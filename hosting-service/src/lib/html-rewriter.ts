/**
 * Safely rewrites absolute paths in HTML to be relative to a base path
 * Only processes common HTML attributes and preserves external URLs, data URIs, etc.
 */

const REWRITABLE_ATTRIBUTES = [
  'src',
  'href',
  'action',
  'data',
  'poster',
  'srcset',
] as const;

/**
 * Check if a path should be rewritten
 */
function shouldRewritePath(path: string): boolean {
  // Must start with /
  if (!path.startsWith('/')) return false;

  // Don't rewrite protocol-relative URLs
  if (path.startsWith('//')) return false;

  // Don't rewrite anchors
  if (path.startsWith('/#')) return false;

  // Don't rewrite data URIs or other schemes
  if (path.includes(':')) return false;

  return true;
}

/**
 * Rewrite a single path
 */
function rewritePath(path: string, basePath: string): string {
  if (!shouldRewritePath(path)) {
    return path;
  }

  // Remove leading slash and prepend base path
  return basePath + path.slice(1);
}

/**
 * Rewrite srcset attribute (can contain multiple URLs)
 * Format: "url1 1x, url2 2x" or "url1 100w, url2 200w"
 */
function rewriteSrcset(srcset: string, basePath: string): string {
  return srcset
    .split(',')
    .map(part => {
      const trimmed = part.trim();
      const spaceIndex = trimmed.indexOf(' ');

      if (spaceIndex === -1) {
        // No descriptor, just URL
        return rewritePath(trimmed, basePath);
      }

      const url = trimmed.substring(0, spaceIndex);
      const descriptor = trimmed.substring(spaceIndex);
      return rewritePath(url, basePath) + descriptor;
    })
    .join(', ');
}

/**
 * Rewrite absolute paths in HTML content
 * Uses simple regex matching for safety (no full HTML parsing)
 */
export function rewriteHtmlPaths(html: string, basePath: string): string {
  // Ensure base path ends with /
  const normalizedBase = basePath.endsWith('/') ? basePath : basePath + '/';

  let rewritten = html;

  // Rewrite each attribute type
  for (const attr of REWRITABLE_ATTRIBUTES) {
    if (attr === 'srcset') {
      // Special handling for srcset
      const srcsetRegex = new RegExp(
        `\\b${attr}\\s*=\\s*"([^"]*)"`,
        'gi'
      );
      rewritten = rewritten.replace(srcsetRegex, (match, value) => {
        const rewrittenValue = rewriteSrcset(value, normalizedBase);
        return `${attr}="${rewrittenValue}"`;
      });
    } else {
      // Regular attributes with quoted values
      const doubleQuoteRegex = new RegExp(
        `\\b${attr}\\s*=\\s*"([^"]*)"`,
        'gi'
      );
      const singleQuoteRegex = new RegExp(
        `\\b${attr}\\s*=\\s*'([^']*)'`,
        'gi'
      );

      rewritten = rewritten.replace(doubleQuoteRegex, (match, value) => {
        const rewrittenValue = rewritePath(value, normalizedBase);
        return `${attr}="${rewrittenValue}"`;
      });

      rewritten = rewritten.replace(singleQuoteRegex, (match, value) => {
        const rewrittenValue = rewritePath(value, normalizedBase);
        return `${attr}='${rewrittenValue}'`;
      });
    }
  }

  return rewritten;
}

/**
 * Check if content is HTML based on content or filename
 */
export function isHtmlContent(
  filepath: string,
  contentType?: string
): boolean {
  if (contentType && contentType.includes('text/html')) {
    return true;
  }

  const ext = filepath.toLowerCase().split('.').pop();
  return ext === 'html' || ext === 'htm';
}
