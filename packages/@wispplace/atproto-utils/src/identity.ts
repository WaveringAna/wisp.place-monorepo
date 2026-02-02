/**
 * AT Protocol identity utilities for resolving handles and DIDs
 */

interface DidDocument {
  service?: Array<{ id: string; serviceEndpoint?: string }>;
  alsoKnownAs?: string[];
}

/**
 * Convert a did:web to an HTTPS URL for fetching the DID document
 */
export function didWebToHttps(did: string): string {
  const didParts = did.split(':');
  if (didParts.length < 3 || didParts[0] !== 'did' || didParts[1] !== 'web') {
    throw new Error('Invalid did:web format');
  }

  const domain = didParts[2];
  const pathParts = didParts.slice(3);

  if (pathParts.length === 0) {
    return `https://${domain}/.well-known/did.json`;
  } else {
    const path = pathParts.join('/');
    return `https://${domain}/${path}/did.json`;
  }
}

/**
 * Resolve a handle or DID to a DID
 * If the identifier is already a DID, returns it as-is
 * If it's a handle, resolves it to a DID using the public API
 */
export async function resolveDid(identifier: string): Promise<string | null> {
  try {
    // If it's already a DID, return it
    if (identifier.startsWith('did:')) {
      return identifier;
    }

    // Otherwise, resolve the handle using the public API
    const url = `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(identifier)}`;
    const response = await fetch(url);

    if (!response.ok) {
      console.error('Failed to resolve handle', identifier, response.status);
      return null;
    }

    const data = await response.json() as { did: string };
    return data.did;
  } catch (err) {
    console.error('Failed to resolve identifier', identifier, err);
    return null;
  }
}

/**
 * Fetch the DID document for a DID
 */
export async function getDidDocument(did: string): Promise<DidDocument | null> {
  try {
    if (did.startsWith('did:plc:')) {
      const res = await fetch(`https://plc.directory/${encodeURIComponent(did)}`);
      if (!res.ok) return null;
      return await res.json() as DidDocument;
    } else if (did.startsWith('did:web:')) {
      const didUrl = didWebToHttps(did);
      const res = await fetch(didUrl);
      if (!res.ok) return null;
      return await res.json() as DidDocument;
    } else {
      console.error('Unsupported DID method', did);
      return null;
    }
  } catch (err) {
    console.error('Failed to fetch DID document', did, err);
    return null;
  }
}

/**
 * Get the PDS endpoint for a DID from its DID document
 */
export async function getPdsForDid(did: string): Promise<string | null> {
  try {
    const doc = await getDidDocument(did);
    if (!doc) return null;

    const services = doc.service || [];
    const pdsService = services.find((s) => s.id === '#atproto_pds');

    return pdsService?.serviceEndpoint || null;
  } catch (err) {
    console.error('Failed to get PDS for DID', did, err);
    return null;
  }
}

/**
 * Get the handle (alsoKnownAs) for a DID from its DID document
 */
export async function getHandleForDid(did: string): Promise<string | null> {
  try {
    const doc = await getDidDocument(did);
    if (!doc) return null;

    const aka = doc.alsoKnownAs || [];
    // Find the at:// handle
    const atHandle = aka.find((h) => h.startsWith('at://'));
    if (atHandle) {
      // Remove 'at://' prefix
      return atHandle.replace('at://', '');
    }

    return null;
  } catch (err) {
    console.error('Failed to get handle for DID', did, err);
    return null;
  }
}

/**
 * Resolve a handle to find its PDS service endpoint
 * Combines resolveDid and getPdsForDid into a single operation
 */
export async function resolvePdsFromHandle(handle: string): Promise<string> {
  const did = await resolveDid(handle);
  if (!did) {
    throw new Error(`Failed to resolve handle: ${handle}`);
  }

  const pdsUrl = await getPdsForDid(did);
  if (!pdsUrl) {
    throw new Error(`Could not find PDS for ${handle} (${did})`);
  }

  return pdsUrl;
}
