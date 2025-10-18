/**
 * AUTHENTICATION ROUTES
 *
 * Handles OAuth authentication flow for Bluesky/ATProto accounts
 * All routes are on the editor.wisp.place subdomain
 *
 * Routes:
 *   POST /api/auth/signin   - Initiate OAuth sign-in flow
 *   GET  /api/auth/callback - OAuth callback handler (redirect from PDS)
 *   GET  /api/auth/status   - Check current authentication status
 *   POST /api/auth/logout   - Sign out and clear session
 */

/**
 * CUSTOM DOMAIN ROUTES
 *
 * Handles custom domain (BYOD - Bring Your Own Domain) management
 * Users can claim custom domains with DNS verification (TXT + CNAME)
 * and map them to their sites
 *
 * Routes:
 *   GET  /api/check-domain            - Fast verification check for routing (public)
 *   GET  /api/custom-domains          - List user's custom domains
 *   POST /api/custom-domains/check    - Check domain availability and DNS config
 *   POST /api/custom-domains/claim    - Claim a custom domain
 *   PUT  /api/custom-domains/:id/site - Update site mapping
 *   DELETE /api/custom-domains/:id    - Remove a custom domain
 *   POST /api/custom-domains/:id/verify - Manually trigger verification
 */

/**
 * WISP SITE MANAGEMENT ROUTES
 *
 * API endpoints for managing user's Wisp sites stored in ATProto repos
 * Handles reading site metadata, fetching content, updating sites, and uploads
 * All routes are on the editor.wisp.place subdomain
 *
 * Routes:
 *   GET  /wisp/sites                - List all sites for authenticated user
 *   GET  /wisp/fs/:site             - Get site record (metadata/manifest)
 *   GET  /wisp/fs/:site/file/*      - Get individual file content by path
 *   POST /wisp/upload-files         - Upload and deploy files as a site
 */
