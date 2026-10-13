/**
 * The API routes wired to the real database, Redis and PDS backfill. The route
 * modules take these as arguments so their tests can supply their own without
 * opening a database.
 */

import * as database from '../lib/db'
import { createPdsBackfill } from '../lib/pds-backfill'
import { hasLivePrivateSite } from '../lib/private-sites-db'
import { getConnectedRedisClient } from '../lib/redis'
import { createAuthRoutes } from './auth'
import { createDomainRoutes } from './domain'
import { createPreviewRoutes, httpPreviewPorts } from './previews'
import { resolvePrivateShareState } from './private-redeem'
import { createSecretRoutes } from './secret'
import { createUserRoutes } from './user'
import { createWebhookRoutes } from './webhook'

const backfillSitesFromPds = createPdsBackfill({ db: database.db, connectRedis: getConnectedRedisClient })

export const authRoutes = createAuthRoutes({ ...database, backfillSitesFromPds, resolvePrivateShareState })
export const domainRoutes = createDomainRoutes({ ...database, hasLivePrivateSite })
export const userRoutes = createUserRoutes({
	...database,
	backfillSitesFromPds,
	connectSiteFenceReader: getConnectedRedisClient,
})
export const webhookRoutes = createWebhookRoutes(database)
export const secretRoutes = createSecretRoutes(database)
export const previewRoutes = createPreviewRoutes(httpPreviewPorts(database))
