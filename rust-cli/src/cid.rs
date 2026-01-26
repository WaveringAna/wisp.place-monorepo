use jacquard_common::types::cid::IpldCid;
use sha2::{Digest, Sha256};

/// Compute CID (Content Identifier) for blob content
/// Uses the same algorithm as AT Protocol: CIDv1 with raw codec (0x55) and SHA-256
/// 
/// CRITICAL: This must be called on BASE64-ENCODED GZIPPED content, not just gzipped content
/// 
/// Based on @atproto/common/src/ipld.ts sha256RawToCid implementation
pub fn compute_cid(content: &[u8]) -> String {
    // Use node crypto to compute sha256 hash (same as AT Protocol)
    let hash = Sha256::digest(content);
    
    // Create multihash (code 0x12 = sha2-256)
    let multihash = multihash::Multihash::wrap(0x12, &hash)
        .expect("SHA-256 hash should always fit in multihash");
    
    // Create CIDv1 with raw codec (0x55)
    let cid = IpldCid::new_v1(0x55, multihash);
    
    // Convert to base32 string representation
    cid.to_string_of_base(multibase::Base::Base32Lower)
        .unwrap_or_else(|_| cid.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    #[test]
    fn test_compute_cid() {
        // Test with a simple string: "hello"
        let content = b"hello";
        let cid = compute_cid(content);
        
        // CID should start with 'baf' for raw codec base32
        assert!(cid.starts_with("baf"));
    }

    #[test]
    fn test_compute_cid_base64_encoded() {
        // Simulate the actual use case: gzipped then base64 encoded
        use flate2::write::GzEncoder;
        use flate2::Compression;
        use std::io::Write;
        
        let original = b"hello world";
        
        // Gzip compress
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(original).unwrap();
        let gzipped = encoder.finish().unwrap();
        
        // Base64 encode the gzipped data
        let base64_bytes = base64::prelude::BASE64_STANDARD.encode(&gzipped).into_bytes();
        
        // Compute CID on the base64 bytes
        let cid = compute_cid(&base64_bytes);
        
        // Should be a valid CID
        assert!(cid.starts_with("baf"));
        assert!(cid.len() > 10);
    }
}

