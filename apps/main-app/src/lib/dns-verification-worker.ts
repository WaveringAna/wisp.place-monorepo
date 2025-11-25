import { verifyCustomDomain } from './dns-verify';
import { db } from './db';

interface VerificationStats {
  totalChecked: number;
  verified: number;
  failed: number;
  errors: number;
}

export class DNSVerificationWorker {
  private interval: Timer | null = null;
  private isRunning = false;
  private lastRunTime: number | null = null;
  private stats: VerificationStats = {
    totalChecked: 0,
    verified: 0,
    failed: 0,
    errors: 0,
  };

  constructor(
    private checkIntervalMs: number = 60 * 60 * 1000, // 1 hour default
    private onLog?: (message: string, data?: any) => void
  ) {}

  private log(message: string, data?: any) {
    if (this.onLog) {
      this.onLog(message, data);
    }
  }

  async start() {
    if (this.isRunning) {
      this.log('DNS verification worker already running');
      return;
    }

    this.isRunning = true;
    this.log('Starting DNS verification worker', {
      intervalMinutes: this.checkIntervalMs / 60000,
    });

    // Run immediately on start
    await this.verifyAllDomains();

    // Then run on interval
    this.interval = setInterval(() => {
      this.verifyAllDomains();
    }, this.checkIntervalMs);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.isRunning = false;
    this.log('DNS verification worker stopped');
  }

  private async verifyAllDomains() {
    this.log('Starting DNS verification check');
    const startTime = Date.now();

    const runStats: VerificationStats = {
      totalChecked: 0,
      verified: 0,
      failed: 0,
      errors: 0,
    };

    try {
      // Get all custom domains (both verified and pending)
      const domains = await db<Array<{
        id: string;
        domain: string;
        did: string;
        verified: boolean;
      }>>`
        SELECT id, domain, did, verified FROM custom_domains
      `;

      if (!domains || domains.length === 0) {
        this.log('No custom domains to check');
        this.lastRunTime = Date.now();
        return;
      }

      const verifiedCount = domains.filter(d => d.verified).length;
      const pendingCount = domains.filter(d => !d.verified).length;
      this.log(`Checking ${domains.length} custom domains (${verifiedCount} verified, ${pendingCount} pending)`);

      // Verify each domain
      for (const row of domains) {
        runStats.totalChecked++;
        const { id, domain, did, verified: wasVerified } = row;

        try {
          // Extract hash from id (SHA256 of did:domain)
          const expectedHash = id.substring(0, 16);

          // Verify DNS records - this will only verify if TXT record matches this specific DID
          const result = await verifyCustomDomain(domain, did, expectedHash);

          if (result.verified) {
            // Double-check: ensure this record is still the current owner in database
            // This prevents race conditions where domain ownership changed during verification
            const currentOwner = await db<Array<{ id: string; did: string; verified: boolean }>>`
              SELECT id, did, verified FROM custom_domains WHERE domain = ${domain}
            `;
            
            const isStillOwner = currentOwner.length > 0 && currentOwner[0].id === id;
            
            if (!isStillOwner) {
              this.log(`⚠️  Domain ownership changed during verification: ${domain}`, {
                expectedId: id,
                expectedDid: did,
                actualId: currentOwner[0]?.id,
                actualDid: currentOwner[0]?.did
              });
              runStats.failed++;
              continue;
            }

            // Update verified status and last_verified_at timestamp
            await db`
              UPDATE custom_domains
              SET verified = true,
                  last_verified_at = EXTRACT(EPOCH FROM NOW())
              WHERE id = ${id}
            `;
            runStats.verified++;
            if (!wasVerified) {
              this.log(`Domain newly verified: ${domain}`, { did });
            } else {
              this.log(`Domain re-verified: ${domain}`, { did });
            }
          } else {
            // Mark domain as unverified or keep it pending
            await db`
              UPDATE custom_domains
              SET verified = false,
                  last_verified_at = EXTRACT(EPOCH FROM NOW())
              WHERE id = ${id}
            `;
            runStats.failed++;
            if (wasVerified) {
              this.log(`Domain verification failed (was verified): ${domain}`, {
                did,
                error: result.error,
                found: result.found,
              });
            } else {
              this.log(`Domain still pending: ${domain}`, {
                did,
                error: result.error,
                found: result.found,
              });
            }
          }
        } catch (error) {
          runStats.errors++;
          this.log(`Error verifying domain: ${domain}`, {
            did,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Update cumulative stats
      this.stats.totalChecked += runStats.totalChecked;
      this.stats.verified += runStats.verified;
      this.stats.failed += runStats.failed;
      this.stats.errors += runStats.errors;

      const duration = Date.now() - startTime;
      this.lastRunTime = Date.now();

      this.log('DNS verification check completed', {
        duration: `${duration}ms`,
        ...runStats,
      });
    } catch (error) {
      this.log('Fatal error in DNS verification worker', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  getHealth() {
    return {
      isRunning: this.isRunning,
      lastRunTime: this.lastRunTime,
      intervalMs: this.checkIntervalMs,
      stats: this.stats,
      healthy: this.isRunning && (
        this.lastRunTime === null ||
        Date.now() - this.lastRunTime < this.checkIntervalMs * 2
      ),
    };
  }

  // Manual trigger for testing
  async trigger() {
    this.log('Manual DNS verification triggered');
    await this.verifyAllDomains();
  }
}
