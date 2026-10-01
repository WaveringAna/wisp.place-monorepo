//! PDS endpoint rules from `@wispplace/atproto-utils` identity.ts, so the CLI
//! talks to the same hosts the TypeScript CLI would.
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use url::{Host, Url};

const MAX_URL_BYTES: usize = 8192;
const BLOCKED_HOSTS: &[&str] = &["metadata.google.internal"];

const PRIVATE_V4: &[([u8; 4], u32)] = &[
    ([0, 0, 0, 0], 8),
    ([10, 0, 0, 0], 8),
    ([100, 64, 0, 0], 10),
    ([127, 0, 0, 0], 8),
    ([169, 254, 0, 0], 16),
    ([172, 16, 0, 0], 12),
    ([192, 0, 0, 0], 24),
    ([192, 0, 2, 0], 24),
    ([192, 31, 196, 0], 24),
    ([192, 52, 193, 0], 24),
    ([192, 88, 99, 0], 24),
    ([192, 168, 0, 0], 16),
    ([192, 175, 48, 0], 24),
    ([198, 18, 0, 0], 15),
    ([198, 51, 100, 0], 24),
    ([203, 0, 113, 0], 24),
    ([224, 0, 0, 0], 4),
    ([240, 0, 0, 0], 4),
];

/// Global unicast is 2000::/3; these special-purpose ranges inside it are not.
const SPECIAL_V6: &[(u128, u32)] = &[
    (0x2001 << 112, 23),
    ((0x2001 << 112) | (0x0db8 << 96), 32),
    // NAT64 may translate an apparently global address to a private IPv4 one.
    ((0x0064 << 112) | (0xff9b << 96), 96),
    ((0x0064 << 112) | (0xff9b << 96) | (0x0001 << 80), 48),
    (0x2002 << 112, 16),
    ((0x2620 << 112) | (0x004f << 96) | (0x8000 << 80), 48),
    (0x3fff << 112, 20),
];

fn in_prefix(address: u128, prefix: u128, bits: u32, width: u32) -> bool {
    let shift = width - bits;
    (address >> shift) == (prefix >> shift)
}

fn public_v4(ip: Ipv4Addr) -> bool {
    let address = u32::from(ip) as u128;
    !PRIVATE_V4
        .iter()
        .any(|(base, bits)| in_prefix(address, u32::from_be_bytes(*base) as u128, *bits, 32))
}

fn public_v6(ip: Ipv6Addr) -> bool {
    let address = u128::from(ip);
    in_prefix(address, 0x2000 << 112, 3, 128)
        && !SPECIAL_V6
            .iter()
            .any(|(base, bits)| in_prefix(address, *base, *bits, 128))
}

fn loopback_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ip.octets()[0] == 127,
        IpAddr::V6(ip) => ip == Ipv6Addr::LOCALHOST,
    }
}

fn valid_name(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host.split('.').all(|label| {
            let bytes = label.as_bytes();
            (1..=63).contains(&bytes.len())
                && bytes
                    .iter()
                    .all(|b| b.is_ascii_alphanumeric() || *b == b'-')
                && bytes[0] != b'-'
                && bytes[bytes.len() - 1] != b'-'
        })
}

/// Whether `host` is loopback: `localhost`, `*.localhost`, 127/8 or ::1.
pub fn is_loopback_host(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(name)) => {
            let name = name.trim_end_matches('.').to_ascii_lowercase();
            name == "localhost" || name.ends_with(".localhost")
        }
        Some(Host::Ipv4(ip)) => loopback_ip(IpAddr::V4(ip)),
        Some(Host::Ipv6(ip)) => loopback_ip(IpAddr::V6(ip)),
        None => false,
    }
}

fn valid_host(url: &Url, allow_loopback: bool) -> bool {
    if is_loopback_host(url) {
        return allow_loopback;
    }
    match url.host() {
        Some(Host::Domain(name)) => {
            let name = name.trim_end_matches('.').to_ascii_lowercase();
            !BLOCKED_HOSTS.contains(&name.as_str()) && valid_name(&name)
        }
        Some(Host::Ipv4(ip)) => public_v4(ip),
        Some(Host::Ipv6(ip)) => public_v6(ip),
        None => false,
    }
}

/// `validatePdsEndpoint`: an https URL on a public host (http only for an
/// allowed loopback dev PDS), without credentials, query or fragment. Returns
/// the endpoint with any trailing slash removed.
pub fn validate_pds_endpoint(endpoint: &str, allow_loopback: bool) -> Option<String> {
    if endpoint.len() > MAX_URL_BYTES {
        return None;
    }
    let url = Url::parse(endpoint).ok()?;
    let secure = match url.scheme() {
        "https" => true,
        "http" => allow_loopback && is_loopback_host(&url),
        _ => false,
    };
    let clean = url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none();
    (secure && clean && valid_host(&url, allow_loopback))
        .then(|| url.as_str().trim_end_matches('/').to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_public_https_endpoints() {
        assert_eq!(
            validate_pds_endpoint("https://pds.example.com/", false).as_deref(),
            Some("https://pds.example.com")
        );
        assert!(validate_pds_endpoint("https://1.1.1.1", false).is_some());
        assert!(validate_pds_endpoint("https://[2606:4700::1111]", false).is_some());
    }

    #[test]
    fn rejects_what_the_ts_cli_rejects() {
        for endpoint in [
            "http://pds.example.com",
            "https://user:pw@pds.example.com",
            "https://pds.example.com/?x=1",
            "https://pds.example.com/#frag",
            "https://10.0.0.1",
            "https://192.168.1.10",
            "https://169.254.169.254",
            "https://[fd00::1]",
            "https://[2001:db8::1]",
            "https://[64:ff9b::a00:1]",
            "https://metadata.google.internal",
            "https://localhost:3300",
            "https://under_score.example",
            "ftp://pds.example.com",
        ] {
            assert_eq!(validate_pds_endpoint(endpoint, false), None, "{endpoint}");
        }
    }

    #[test]
    fn loopback_only_when_allowed() {
        assert_eq!(validate_pds_endpoint("http://localhost:3300", false), None);
        assert_eq!(
            validate_pds_endpoint("http://localhost:3300", true).as_deref(),
            Some("http://localhost:3300")
        );
        assert!(validate_pds_endpoint("http://127.0.0.1:3300", true).is_some());
        assert_eq!(validate_pds_endpoint("http://10.0.0.1", true), None);
    }
}
