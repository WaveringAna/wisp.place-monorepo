/**
 * HTML page generation utilities for hosting service
 * Generates 404 pages, directory listings, and updating pages
 */

/**
 * Generate 404 page HTML
 */
export function generate404Page(): string {
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>404 - Not Found</title>
  <style>
    @media (prefers-color-scheme: light) {
      :root {
        /* Warm beige background */
        --background: oklch(0.90 0.012 35);
        /* Very dark brown text */
        --foreground: oklch(0.18 0.01 30);
        --border: oklch(0.75 0.015 30);
        /* Bright pink accent for links */
        --accent: oklch(0.78 0.15 345);
      }
    }
    @media (prefers-color-scheme: dark) {
      :root {
        /* Slate violet background */
        --background: oklch(0.23 0.015 285);
        /* Light gray text */
        --foreground: oklch(0.90 0.005 285);
        /* Subtle borders */
        --border: oklch(0.38 0.02 285);
        /* Soft pink accent */
        --accent: oklch(0.85 0.08 5);
      }
    }
    body {
      font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
      background: var(--background);
      color: var(--foreground);
      padding: 2rem;
      max-width: 800px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      min-height: 100vh;
      justify-content: center;
      align-items: center;
      text-align: center;
    }
    h1 {
      font-size: 6rem;
      margin: 0;
      font-weight: 700;
      line-height: 1;
    }
    h2 {
      font-size: 1.5rem;
      margin: 1rem 0 2rem;
      font-weight: 400;
      opacity: 0.8;
    }
    p {
      font-size: 1rem;
      opacity: 0.7;
      margin-bottom: 2rem;
    }
    a {
      color: var(--accent);
      text-decoration: none;
      font-size: 1rem;
    }
    a:hover {
      text-decoration: underline;
    }
    footer {
      margin-top: 2rem;
      padding-top: 1.5rem;
      border-top: 1px solid var(--border);
      text-align: center;
      font-size: 0.875rem;
      opacity: 0.7;
      color: var(--foreground);
    }
    footer a {
      color: var(--accent);
      text-decoration: none;
      display: inline;
    }
    footer a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div>
    <h1>404</h1>
    <h2>Page not found</h2>
    <p>The page you're looking for doesn't exist.</p>
    <a href="/">← Back to home</a>
  </div>
  <footer>
    Hosted on <a href="https://wisp.place" target="_blank" rel="noopener">wisp.place</a> - Made by <a href="https://bsky.app/profile/nekomimi.pet" target="_blank" rel="noopener">@nekomimi.pet</a>
  </footer>
</body>
</html>`;
  return html;
}

/**
 * Generate directory listing HTML
 */
export function generateDirectoryListing(path: string, entries: Array<{name: string, isDirectory: boolean}>): string {
  const title = path || 'Index';

  // Sort: directories first, then files, alphabetically within each group
  const sortedEntries = [...entries].sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;
    return a.name.localeCompare(b.name);
  });

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Index of /${path}</title>
  <style>
    @media (prefers-color-scheme: light) {
      :root {
        /* Warm beige background */
        --background: oklch(0.90 0.012 35);
        /* Very dark brown text */
        --foreground: oklch(0.18 0.01 30);
        --border: oklch(0.75 0.015 30);
        /* Bright pink accent for links */
        --accent: oklch(0.78 0.15 345);
        /* Lavender for folders */
        --folder: oklch(0.60 0.12 295);
        --icon: oklch(0.28 0.01 30);
      }
    }
    @media (prefers-color-scheme: dark) {
      :root {
        /* Slate violet background */
        --background: oklch(0.23 0.015 285);
        /* Light gray text */
        --foreground: oklch(0.90 0.005 285);
        /* Subtle borders */
        --border: oklch(0.38 0.02 285);
        /* Soft pink accent */
        --accent: oklch(0.85 0.08 5);
        /* Lavender for folders */
        --folder: oklch(0.70 0.10 295);
        --icon: oklch(0.85 0.005 285);
      }
    }
    body {
      font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
      background: var(--background);
      color: var(--foreground);
      padding: 2rem;
      max-width: 800px;
      margin: 0 auto;
    }
    h1 {
      font-size: 1.5rem;
      margin-bottom: 2rem;
      padding-bottom: 0.5rem;
      border-bottom: 1px solid var(--border);
    }
    ul {
      list-style: none;
      padding: 0;
    }
    li {
      padding: 0.5rem 0;
      border-bottom: 1px solid var(--border);
    }
    li:last-child {
      border-bottom: none;
    }
    li a {
      color: var(--accent);
      text-decoration: none;
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    li a:hover {
      text-decoration: underline;
    }
    .folder {
      color: var(--folder);
      font-weight: 600;
    }
    .file {
      color: var(--accent);
    }
    .folder::before,
    .file::before,
    .parent::before {
      content: "";
      display: inline-block;
      width: 1.25em;
      height: 1.25em;
      background-color: var(--icon);
      flex-shrink: 0;
      -webkit-mask-size: contain;
      mask-size: contain;
      -webkit-mask-repeat: no-repeat;
      mask-repeat: no-repeat;
      -webkit-mask-position: center;
      mask-position: center;
    }
    .folder::before {
      -webkit-mask-image: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M64 15v37a5.006 5.006 0 0 1-5 5H5a5.006 5.006 0 0 1-5-5V12a5.006 5.006 0 0 1 5-5h14.116a6.966 6.966 0 0 1 5.466 2.627l5 6.247A2.983 2.983 0 0 0 31.922 17H59a1 1 0 0 1 0 2H31.922a4.979 4.979 0 0 1-3.9-1.876l-5-6.247A4.976 4.976 0 0 0 19.116 9H5a3 3 0 0 0-3 3v40a3 3 0 0 0 3 3h54a3 3 0 0 0 3-3V15a3 3 0 0 0-3-3H30a1 1 0 0 1 0-2h29a5.006 5.006 0 0 1 5 5z"/></svg>');
      mask-image: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M64 15v37a5.006 5.006 0 0 1-5 5H5a5.006 5.006 0 0 1-5-5V12a5.006 5.006 0 0 1 5-5h14.116a6.966 6.966 0 0 1 5.466 2.627l5 6.247A2.983 2.983 0 0 0 31.922 17H59a1 1 0 0 1 0 2H31.922a4.979 4.979 0 0 1-3.9-1.876l-5-6.247A4.976 4.976 0 0 0 19.116 9H5a3 3 0 0 0-3 3v40a3 3 0 0 0 3 3h54a3 3 0 0 0 3-3V15a3 3 0 0 0-3-3H30a1 1 0 0 1 0-2h29a5.006 5.006 0 0 1 5 5z"/></svg>');
    }
    .file::before {
      -webkit-mask-image: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 25 25"><g><path d="M18 8.28a.59.59 0 0 0-.13-.18l-4-3.9h-.05a.41.41 0 0 0-.15-.2.41.41 0 0 0-.19 0h-9a.5.5 0 0 0-.5.5v19a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5V8.43a.58.58 0 0 0 .02-.15zM16.3 8H14V5.69zM5 23V5h8v3.5a.49.49 0 0 0 .15.36.5.5 0 0 0 .35.14l3.5-.06V23z"/><path d="M20.5 1h-13a.5.5 0 0 0-.5.5V3a.5.5 0 0 0 1 0V2h12v18h-1a.5.5 0 0 0 0 1h1.5a.5.5 0 0 0 .5-.5v-19a.5.5 0 0 0-.5-.5z"/><path d="M7.5 8h3a.5.5 0 0 0 0-1h-3a.5.5 0 0 0 0 1zM7.5 11h4a.5.5 0 0 0 0-1h-4a.5.5 0 0 0 0 1zM13.5 13h-6a.5.5 0 0 0 0 1h6a.5.5 0 0 0 0-1zM13.5 16h-6a.5.5 0 0 0 0 1h6a.5.5 0 0 0 0-1zM13.5 19h-6a.5.5 0 0 0 0 1h6a.5.5 0 0 0 0-1z"/></g></svg>');
      mask-image: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 25 25"><g><path d="M18 8.28a.59.59 0 0 0-.13-.18l-4-3.9h-.05a.41.41 0 0 0-.15-.2.41.41 0 0 0-.19 0h-9a.5.5 0 0 0-.5.5v19a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5V8.43a.58.58 0 0 0 .02-.15zM16.3 8H14V5.69zM5 23V5h8v3.5a.49.49 0 0 0 .15.36.5.5 0 0 0 .35.14l3.5-.06V23z"/><path d="M20.5 1h-13a.5.5 0 0 0-.5.5V3a.5.5 0 0 0 1 0V2h12v18h-1a.5.5 0 0 0 0 1h1.5a.5.5 0 0 0 .5-.5v-19a.5.5 0 0 0-.5-.5z"/><path d="M7.5 8h3a.5.5 0 0 0 0-1h-3a.5.5 0 0 0 0 1zM7.5 11h4a.5.5 0 0 0 0-1h-4a.5.5 0 0 0 0 1zM13.5 13h-6a.5.5 0 0 0 0 1h6a.5.5 0 0 0 0-1zM13.5 16h-6a.5.5 0 0 0 0 1h6a.5.5 0 0 0 0-1zM13.5 19h-6a.5.5 0 0 0 0 1h6a.5.5 0 0 0 0-1z"/></g></svg>');
    }
    .parent::before {
      -webkit-mask-image: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg>');
      mask-image: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg>');
    }
    footer {
      margin-top: 2rem;
      padding-top: 1.5rem;
      border-top: 1px solid var(--border);
      text-align: center;
      font-size: 0.875rem;
      opacity: 0.7;
      color: var(--foreground);
    }
    footer a {
      color: var(--accent);
      text-decoration: none;
      display: inline;
    }
    footer a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <h1>Index of /${path}</h1>
  <ul>
    ${path ? '<li><a href="../" class="parent">../</a></li>' : ''}
    ${sortedEntries.map(e =>
      `<li><a href="${e.name}${e.isDirectory ? '/' : ''}" class="${e.isDirectory ? 'folder' : 'file'}">${e.name}${e.isDirectory ? '/' : ''}</a></li>`
    ).join('\n    ')}
  </ul>
  <footer>
    Hosted on <a href="https://wisp.place" target="_blank" rel="noopener">wisp.place</a> - Made by <a href="https://bsky.app/profile/nekomimi.pet" target="_blank" rel="noopener">@nekomimi.pet</a>
  </footer>
</body>
</html>`;
  return html;
}

/**
 * Return a response indicating the site is being updated
 */
export function generateSiteUpdatingPage(): string {
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Site Updating</title>
  <style>
    @media (prefers-color-scheme: light) {
      :root {
        --background: oklch(0.90 0.012 35);
        --foreground: oklch(0.18 0.01 30);
        --primary: oklch(0.35 0.02 35);
        --accent: oklch(0.78 0.15 345);
      }
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --background: oklch(0.23 0.015 285);
        --foreground: oklch(0.90 0.005 285);
        --primary: oklch(0.70 0.10 295);
        --accent: oklch(0.85 0.08 5);
      }
    }
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: var(--background);
      color: var(--foreground);
    }
    .container {
      text-align: center;
      padding: 2rem;
      max-width: 500px;
    }
    h1 {
      font-size: 2.5rem;
      margin-bottom: 1rem;
      font-weight: 600;
      color: var(--primary);
    }
    p {
      font-size: 1.25rem;
      opacity: 0.8;
      margin-bottom: 2rem;
      color: var(--foreground);
    }
    .spinner {
      border: 4px solid var(--accent);
      border-radius: 50%;
      border-top: 4px solid var(--primary);
      width: 40px;
      height: 40px;
      animation: spin 1s linear infinite;
      margin: 0 auto;
    }
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
  </style>
  <meta http-equiv="refresh" content="3">
</head>
<body>
  <div class="container">
    <h1>Site Updating</h1>
    <p>This site is undergoing an update right now. Check back in a moment...</p>
    <div class="spinner"></div>
  </div>
</body>
</html>`;

  return html;
}

/**
 * Create a Response for site updating
 */
export function siteUpdatingResponse(): Response {
  return new Response(generateSiteUpdatingPage(), {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Retry-After': '3',
    },
  });
}

