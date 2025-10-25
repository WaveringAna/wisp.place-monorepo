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
      // Get all verified custom domains
      const domains = await db`
        SELECT id, domain, did FROM custom_domains WHERE verified = true
      `;

      if (!domains || domains.length === 0) {
        this.log('No verified custom domains to check');
        this.lastRunTime = Date.now();
        return;
      }

      this.log(`Checking ${domains.length} verified custom domains`);

      // Verify each domain
      for (const row of domains) {
        runStats.totalChecked++;
        const { id, domain, did } = row;

        try {
          // Extract hash from id (SHA256 of did:domain)
          const expectedHash = id.substring(0, 16);

          // Verify DNS records
          const result = await verifyCustomDomain(domain, did, expectedHash);

          if (result.verified) {
            // Update last_verified_at timestamp
            await db`
              UPDATE custom_domains
              SET last_verified_at = EXTRACT(EPOCH FROM NOW())
              WHERE id = ${id}
            `;
            runStats.verified++;
            this.log(`Domain verified: ${domain}`, { did });
          } else {
            // Mark domain as unverified
            await db`
              UPDATE custom_domains
              SET verified = false,
                  last_verified_at = EXTRACT(EPOCH FROM NOW())
              WHERE id = ${id}
            `;
            runStats.failed++;
            this.log(`Domain verification failed: ${domain}`, {
              did,
              error: result.error,
              found: result.found,
            });
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
