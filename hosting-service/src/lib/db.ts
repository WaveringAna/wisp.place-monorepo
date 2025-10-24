import postgres from 'postgres';

const sql = postgres(
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/wisp',
  {
    max: 10,
    idle_timeout: 20,
  }
);

export interface DomainLookup {
  did: string;
  rkey: string | null;
}

export interface CustomDomainLookup {
  id: string;
  domain: string;
  did: string;
  rkey: string;
  verified: boolean;
}

export async function getWispDomain(domain: string): Promise<DomainLookup | null> {
  const result = await sql<DomainLookup[]>`
    SELECT did, rkey FROM domains WHERE domain = ${domain.toLowerCase()} LIMIT 1
  `;
  return result[0] || null;
}

export async function getCustomDomain(domain: string): Promise<CustomDomainLookup | null> {
  const result = await sql<CustomDomainLookup[]>`
    SELECT id, domain, did, rkey, verified FROM custom_domains
    WHERE domain = ${domain.toLowerCase()} AND verified = true LIMIT 1
  `;
  return result[0] || null;
}

export async function getCustomDomainByHash(hash: string): Promise<CustomDomainLookup | null> {
  const result = await sql<CustomDomainLookup[]>`
    SELECT id, domain, did, rkey, verified FROM custom_domains
    WHERE id = ${hash} AND verified = true LIMIT 1
  `;
  return result[0] || null;
}

export async function upsertSite(did: string, rkey: string, displayName?: string) {
  try {
    // Only set display_name if provided (not undefined/null/empty)
    const cleanDisplayName = displayName && displayName.trim() ? displayName.trim() : null;

    await sql`
      INSERT INTO sites (did, rkey, display_name, created_at, updated_at)
      VALUES (${did}, ${rkey}, ${cleanDisplayName}, EXTRACT(EPOCH FROM NOW()), EXTRACT(EPOCH FROM NOW()))
      ON CONFLICT (did, rkey)
      DO UPDATE SET
        display_name = CASE
          WHEN EXCLUDED.display_name IS NOT NULL THEN EXCLUDED.display_name
          ELSE sites.display_name
        END,
        updated_at = EXTRACT(EPOCH FROM NOW())
    `;
  } catch (err) {
    console.error('Failed to upsert site', err);
  }
}

export { sql };
