//! OAuth permission-set expansion and semantic grant checks.

pub const WISP_SITE_COLLECTIONS: &[&str] = &[
    "place.wisp.fs",
    "place.wisp.subfs",
    "place.wisp.settings",
    "place.wisp.domain",
];
pub const WISP_WEBHOOK_COLLECTIONS: &[&str] = &["place.wisp.v2.wh"];
pub const WISP_HOSTING_LXMS: &[&str] = &[
    "place.wisp.v2.domain.addSite",
    "place.wisp.v2.domain.claim",
    "place.wisp.v2.domain.claimSubdomain",
    "place.wisp.v2.domain.delete",
    "place.wisp.v2.domain.getList",
    "place.wisp.v2.domain.getStatus",
    "place.wisp.v2.domain.verify",
    "place.wisp.v2.privateSite.create",
    "place.wisp.v2.privateSite.createShare",
    "place.wisp.v2.privateSite.delete",
    "place.wisp.v2.privateSite.list",
    "place.wisp.v2.privateSite.listShares",
    "place.wisp.v2.privateSite.revokeShare",
    "place.wisp.v2.site.delete",
    "place.wisp.v2.site.getDomains",
    "place.wisp.v2.site.getList",
];
pub const WISP_SECRET_LXMS: &[&str] = &[
    "place.wisp.v2.secret.create",
    "place.wisp.v2.secret.delete",
    "place.wisp.v2.secret.list",
    "place.wisp.v2.secret.rotate",
];
pub const REPO_ACTIONS: &[&str] = &["create", "update", "delete"];
pub const WISP_PERMISSION_SET_SITES: &str = "place.wisp.authSites";
pub const WISP_PERMISSION_SET_WEBHOOKS: &str = "place.wisp.authWebhooks";
pub const WISP_PERMISSION_SET_HOSTING: &str = "place.wisp.authHosting";
pub const WISP_PERMISSION_SET_FULL: &str = "place.wisp.authFullAccess";
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PermissionSet {
    pub nsid: &'static str,
    pub title: &'static str,
    pub detail: &'static str,
}

pub const WISP_PERMISSION_SETS: &[PermissionSet] = &[
    PermissionSet {
        nsid: WISP_PERMISSION_SET_SITES,
        title: "Manage your wisp.place sites",
        detail: "Create, update, and delete your site files and settings.",
    },
    PermissionSet {
        nsid: WISP_PERMISSION_SET_WEBHOOKS,
        title: "Manage your wisp.place webhooks",
        detail: "Create, update, and delete your webhook subscriptions.",
    },
    PermissionSet {
        nsid: WISP_PERMISSION_SET_HOSTING,
        title: "Use wisp.place hosting features",
        detail: "Manage your sites, custom domains, and private site links.",
    },
    PermissionSet {
        nsid: WISP_PERMISSION_SET_FULL,
        title: "Full wisp.place access",
        detail: "Full control of your sites, domains, and webhooks.",
    },
];

pub const WISP_CLI_PERMISSION_SETS: &[&str] =
    &[WISP_PERMISSION_SET_SITES, WISP_PERMISSION_SET_HOSTING];
pub const WISP_APP_PERMISSION_SETS: &[&str] =
    &[WISP_PERMISSION_SET_SITES, WISP_PERMISSION_SET_WEBHOOKS];

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WispCapability {
    Repo { collection: String, action: String },
    Rpc { lxm: String, aud: String },
    Blob { mime: String },
}

pub fn describe_capability(capability: &WispCapability) -> String {
    match capability {
        WispCapability::Repo { collection, action } => format!("{action} {collection} records"),
        WispCapability::Rpc { lxm, .. } => format!("call {lxm}"),
        WispCapability::Blob { mime } => format!("upload {mime} blobs"),
    }
}

fn repo_capabilities(collections: &[&str]) -> Vec<WispCapability> {
    collections
        .iter()
        .flat_map(|collection| {
            REPO_ACTIONS.iter().map(move |action| WispCapability::Repo {
                collection: (*collection).into(),
                action: (*action).into(),
            })
        })
        .collect()
}

fn rpc_capabilities(lxms: &[&str]) -> Vec<WispCapability> {
    lxms.iter()
        .map(|lxm| WispCapability::Rpc {
            lxm: (*lxm).into(),
            aud: "*".into(),
        })
        .collect()
}

pub fn permission_set_capabilities(nsid: &str) -> Result<Vec<WispCapability>, String> {
    match nsid {
        WISP_PERMISSION_SET_SITES => Ok(repo_capabilities(WISP_SITE_COLLECTIONS)),
        WISP_PERMISSION_SET_WEBHOOKS => Ok(repo_capabilities(WISP_WEBHOOK_COLLECTIONS)),
        WISP_PERMISSION_SET_HOSTING => Ok(rpc_capabilities(WISP_HOSTING_LXMS)),
        WISP_PERMISSION_SET_FULL => Ok([
            repo_capabilities(WISP_SITE_COLLECTIONS),
            repo_capabilities(WISP_WEBHOOK_COLLECTIONS),
            rpc_capabilities(WISP_HOSTING_LXMS),
            rpc_capabilities(WISP_SECRET_LXMS),
        ]
        .concat()),
        _ => Err(format!("Unknown wisp permission set: {nsid}")),
    }
}

pub fn include_scopes(nsids: &[&str]) -> Vec<String> {
    nsids.iter().map(|nsid| format!("include:{nsid}")).collect()
}

pub fn expand_permission_sets(nsids: &[&str]) -> Vec<String> {
    let mut scopes = Vec::new();
    for capability in nsids
        .iter()
        .flat_map(|nsid| permission_set_capabilities(nsid).unwrap_or_default())
    {
        let scope = match capability {
            WispCapability::Repo { collection, .. } => format!("repo:{collection}"),
            WispCapability::Rpc { lxm, aud } => format!("rpc:{lxm}?aud={aud}"),
            WispCapability::Blob { .. } => continue,
        };
        if !scopes.contains(&scope) {
            scopes.push(scope);
        }
    }
    scopes
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WispScopes {
    pub preferred: String,
    pub legacy: String,
    pub metadata: String,
}

pub fn build_wisp_scopes(nsids: &[&str]) -> WispScopes {
    build_wisp_scopes_with_extra(nsids, &["atproto", "blob:*/*"])
}

pub fn build_wisp_scopes_with_extra(nsids: &[&str], extra: &[&str]) -> WispScopes {
    let preferred: Vec<_> = extra
        .iter()
        .map(|s| (*s).into())
        .chain(include_scopes(nsids))
        .collect();
    let legacy: Vec<_> = extra
        .iter()
        .map(|s| (*s).into())
        .chain(expand_permission_sets(nsids))
        .collect();
    let mut metadata = Vec::new();
    for scope in preferred.iter().chain(&legacy) {
        if !metadata.contains(scope) {
            metadata.push(scope.clone());
        }
    }
    WispScopes {
        preferred: preferred.join(" "),
        legacy: legacy.join(" "),
        metadata: metadata.join(" "),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedScope {
    pub prefix: String,
    pub positional: Option<String>,
    pub params: Vec<(String, String)>,
}

fn decode_positional(raw: &str) -> String {
    // decodeURIComponent rejects malformed escapes instead of partially decoding.
    let bytes = raw.as_bytes();
    if bytes.iter().enumerate().any(|(i, b)| {
        *b == b'%'
            && (i + 2 >= bytes.len()
                || !bytes[i + 1].is_ascii_hexdigit()
                || !bytes[i + 2].is_ascii_hexdigit())
    }) {
        return raw.into();
    }
    percent_encoding::percent_decode_str(raw)
        .decode_utf8()
        .map_or_else(|_| raw.into(), |s| s.into_owned())
}

pub fn parse_scope_value(value: &str) -> ParsedScope {
    let query = value.find('?');
    let colon = value.find(':');
    let end = query.into_iter().chain(colon).min().unwrap_or(value.len());
    let positional = colon
        .filter(|c| query.is_none_or(|q| *c < q))
        .map(|c| decode_positional(&value[c + 1..query.unwrap_or(value.len())]));
    let params = query
        .map(|q| {
            url::form_urlencoded::parse(&value.as_bytes()[q + 1..])
                .into_owned()
                .collect()
        })
        .unwrap_or_default();
    ParsedScope {
        prefix: value[..end].into(),
        positional,
        params,
    }
}

impl ParsedScope {
    fn values(&self, key: &str) -> Vec<&str> {
        self.params
            .iter()
            .filter(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
            .collect()
    }
    fn targets(&self, key: &str) -> Vec<&str> {
        let values = self.values(key);
        if values.is_empty() {
            self.positional.as_deref().into_iter().collect()
        } else {
            values
        }
    }
    fn grants(&self, capability: &WispCapability) -> bool {
        match capability {
            WispCapability::Repo { collection, action } if self.prefix == "repo" => {
                let targets = self.targets("collection");
                let actions = self.values("action");
                (targets.contains(&"*") || targets.contains(&collection.as_str()))
                    && (actions.is_empty() || actions.contains(&action.as_str()))
            }
            WispCapability::Rpc { lxm, aud } if self.prefix == "rpc" => {
                let targets = self.targets("lxm");
                let granted_aud = self.values("aud").first().copied();
                (targets.contains(&"*") || targets.contains(&lxm.as_str()))
                    && (granted_aud == Some("*")
                        || (aud != "*" && granted_aud == Some(aud.as_str())))
            }
            WispCapability::Blob { mime } if self.prefix == "blob" => {
                let wildcard = format!("{}/*", mime.split('/').next().unwrap_or(mime));
                self.targets("accept")
                    .iter()
                    .any(|accept| *accept == "*/*" || *accept == mime || *accept == wildcard)
            }
            _ => false,
        }
    }
}

pub fn missing_capabilities(
    granted_scope: Option<&str>,
    required: &[WispCapability],
) -> Vec<WispCapability> {
    let granted: Vec<_> = granted_scope
        .unwrap_or_default()
        .split_whitespace()
        .map(parse_scope_value)
        .collect();
    required
        .iter()
        .filter(|capability| !granted.iter().any(|scope| scope.grants(capability)))
        .cloned()
        .collect()
}

pub fn wisp_cli_required_capabilities() -> Vec<WispCapability> {
    let rpc = WISP_HOSTING_LXMS
        .iter()
        .copied()
        .filter(|lxm| *lxm != "place.wisp.v2.site.getDomains")
        .collect::<Vec<_>>();
    [
        repo_capabilities(&["place.wisp.fs", "place.wisp.subfs", "place.wisp.settings"]),
        rpc_capabilities(&rpc),
        vec![WispCapability::Blob { mime: "*/*".into() }],
    ]
    .concat()
}

pub fn wisp_app_required_capabilities() -> Vec<WispCapability> {
    [
        repo_capabilities(WISP_SITE_COLLECTIONS),
        repo_capabilities(WISP_WEBHOOK_COLLECTIONS),
        vec![WispCapability::Blob { mime: "*/*".into() }],
    ]
    .concat()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn repo(action: &str) -> WispCapability {
        WispCapability::Repo {
            collection: "place.wisp.fs".into(),
            action: action.into(),
        }
    }
    fn rpc(aud: &str) -> WispCapability {
        WispCapability::Rpc {
            lxm: "place.wisp.v2.site.getList".into(),
            aud: aud.into(),
        }
    }
    fn blob(mime: &str) -> WispCapability {
        WispCapability::Blob { mime: mime.into() }
    }
    #[test]
    fn matches_typescript_fixture_byte_for_byte() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("scopes.fixture.json")).unwrap();
        let scopes = build_wisp_scopes(WISP_CLI_PERMISSION_SETS);
        assert_eq!(scopes.preferred, fixture["preferred"].as_str().unwrap());
        assert_eq!(scopes.legacy, fixture["legacy"].as_str().unwrap());
        assert_eq!(scopes.metadata, fixture["metadata"].as_str().unwrap());
    }
    #[test]
    fn sets_stay_in_authority_and_use_any_audience() {
        for nsid in [
            WISP_PERMISSION_SET_SITES,
            WISP_PERMISSION_SET_WEBHOOKS,
            WISP_PERMISSION_SET_HOSTING,
            WISP_PERMISSION_SET_FULL,
        ] {
            for cap in permission_set_capabilities(nsid).unwrap() {
                match cap {
                    WispCapability::Repo { collection, .. } => {
                        assert!(collection.starts_with("place.wisp."))
                    }
                    WispCapability::Rpc { lxm, aud } => {
                        assert!(lxm.starts_with("place.wisp."));
                        assert_eq!(aud, "*");
                    }
                    _ => panic!("sets cannot contain blob permissions"),
                }
            }
        }
    }
    #[test]
    fn full_access_contains_every_other_set() {
        let full = permission_set_capabilities(WISP_PERMISSION_SET_FULL).unwrap();
        for nsid in [
            WISP_PERMISSION_SET_SITES,
            WISP_PERMISSION_SET_WEBHOOKS,
            WISP_PERMISSION_SET_HOSTING,
        ] {
            assert!(
                permission_set_capabilities(nsid)
                    .unwrap()
                    .iter()
                    .all(|c| full.contains(c))
            );
        }
    }
    #[test]
    fn scope_strings_declare_both_strategies() {
        let scopes = build_wisp_scopes(WISP_CLI_PERMISSION_SETS);
        assert_eq!(
            scopes.preferred,
            "atproto blob:*/* include:place.wisp.authSites include:place.wisp.authHosting"
        );
        assert!(scopes.legacy.contains("repo:place.wisp.fs"));
        assert!(!scopes.legacy.contains("include:"));
        for scope in scopes
            .preferred
            .split_whitespace()
            .chain(scopes.legacy.split_whitespace())
        {
            assert!(scopes.metadata.split_whitespace().any(|s| s == scope));
        }
        assert!(
            missing_capabilities(Some(&scopes.legacy), &wisp_cli_required_capabilities())
                .is_empty()
        );
    }
    #[test]
    fn metadata_deduplicates_extra_scopes_without_changing_the_request() {
        let scopes = build_wisp_scopes_with_extra(&[], &["atproto", "atproto"]);
        assert_eq!(scopes.preferred, "atproto atproto");
        assert_eq!(scopes.legacy, "atproto atproto");
        assert_eq!(scopes.metadata, "atproto");
    }
    #[test]
    fn scope_expansion_deduplicates_and_ignores_unknown_sets() {
        assert_eq!(
            expand_permission_sets(&[
                WISP_PERMISSION_SET_SITES,
                WISP_PERMISSION_SET_SITES,
                "unknown"
            ]),
            expand_permission_sets(&[WISP_PERMISSION_SET_SITES])
        );
        assert!(permission_set_capabilities("unknown").is_err());
        assert!(
            !expand_permission_sets(WISP_APP_PERMISSION_SETS)
                .iter()
                .any(|s| s == "atproto" || s.starts_with("blob:"))
        );
    }
    #[test]
    fn parser_handles_bare_positional_and_grouped_forms() {
        assert_eq!(
            parse_scope_value("atproto"),
            ParsedScope {
                prefix: "atproto".into(),
                positional: None,
                params: vec![]
            }
        );
        assert_eq!(
            parse_scope_value("repo:place.wisp.fs")
                .positional
                .as_deref(),
            Some("place.wisp.fs")
        );
        let grouped = parse_scope_value("rpc?lxm=one&lxm=two&aud=*");
        assert_eq!(grouped.values("lxm"), vec!["one", "two"]);
        assert_eq!(grouped.values("aud"), vec!["*"]);
    }
    #[test]
    fn parser_percent_decoding_matches_javascript() {
        assert_eq!(
            parse_scope_value("blob:image%2Fpng").positional.as_deref(),
            Some("image/png")
        );
        assert_eq!(
            parse_scope_value("blob:a+b").positional.as_deref(),
            Some("a+b")
        );
        assert_eq!(
            parse_scope_value("blob:%FF%2F").positional.as_deref(),
            Some("%FF%2F")
        );
        assert_eq!(
            parse_scope_value("blob:a%2Fb%zz").positional.as_deref(),
            Some("a%2Fb%zz")
        );
        assert_eq!(parse_scope_value("rpc?aud=a+b").values("aud"), vec!["a b"]);
        assert_eq!(parse_scope_value("rpc?aud=did:web:test").prefix, "rpc");
    }
    #[test]
    fn grouped_server_grants_cover_both_clients() {
        let grouped_repo = format!(
            "repo?{}",
            WISP_SITE_COLLECTIONS
                .iter()
                .map(|s| format!("collection={s}"))
                .collect::<Vec<_>>()
                .join("&")
        );
        let grouped_rpc = format!(
            "rpc?{}&aud=*",
            WISP_HOSTING_LXMS
                .iter()
                .map(|s| format!("lxm={s}"))
                .collect::<Vec<_>>()
                .join("&")
        );
        assert!(
            missing_capabilities(
                Some(&format!("atproto blob:*/* {grouped_repo} {grouped_rpc}")),
                &wisp_cli_required_capabilities()
            )
            .is_empty()
        );
        assert!(
            missing_capabilities(
                Some(&format!(
                    "atproto blob:*/* {grouped_repo} repo:place.wisp.v2.wh"
                )),
                &wisp_app_required_capabilities()
            )
            .is_empty()
        );
    }
    #[test]
    fn ignored_includes_are_not_grants() {
        let required = wisp_cli_required_capabilities();
        assert_eq!(
            missing_capabilities(
                Some(&build_wisp_scopes(WISP_CLI_PERMISSION_SETS).preferred),
                &required
            )
            .len(),
            required.len() - 1
        );
        assert_eq!(missing_capabilities(None, &required), required);
    }
    #[test]
    fn repo_actions_and_wildcards() {
        assert_eq!(
            missing_capabilities(
                Some("repo:place.wisp.fs?action=create&action=update"),
                &[repo("delete")]
            ),
            vec![repo("delete")]
        );
        assert!(
            missing_capabilities(
                Some("repo:place.wisp.fs?action=create&action=update"),
                &[repo("update")]
            )
            .is_empty()
        );
        assert!(missing_capabilities(Some("repo:*"), &[repo("delete")]).is_empty());
        assert!(!missing_capabilities(Some("repo:place.wisp.*"), &[repo("delete")]).is_empty());
    }
    #[test]
    fn rpc_audience_must_cover_the_requirement() {
        let pinned = "rpc:place.wisp.v2.site.getList?aud=did:web:wisp.place%23wisp_xrpc";
        assert_eq!(
            missing_capabilities(Some(pinned), &[rpc("*")]),
            vec![rpc("*")]
        );
        assert!(
            missing_capabilities(Some(pinned), &[rpc("did:web:wisp.place#wisp_xrpc")]).is_empty()
        );
        assert!(!missing_capabilities(Some("rpc:*"), &[rpc("*")]).is_empty());
        assert!(missing_capabilities(Some("rpc:*?aud=*"), &[rpc("*")]).is_empty());
    }
    #[test]
    fn blob_mime_matching() {
        assert!(missing_capabilities(Some("blob:image/*"), &[blob("image/png")]).is_empty());
        assert_eq!(
            missing_capabilities(Some("blob:image/*"), &[blob("text/html")]),
            vec![blob("text/html")]
        );
        assert!(
            missing_capabilities(
                Some("blob?accept=image/png&accept=text/html"),
                &[blob("text/html")]
            )
            .is_empty()
        );
        assert!(!missing_capabilities(Some("blob:image/*"), &[blob("*/*")]).is_empty());
    }
    #[test]
    fn grouped_params_override_positional_shorthand() {
        assert!(
            !missing_capabilities(Some("repo:*?collection=other"), &[repo("delete")]).is_empty()
        );
    }
    #[test]
    fn old_sessions_remain_valid() {
        let cli = format!(
            "atproto repo:place.wisp.fs repo:place.wisp.subfs repo:place.wisp.settings blob:*/* {}",
            WISP_HOSTING_LXMS
                .iter()
                .filter(|s| **s != "place.wisp.v2.site.getDomains")
                .map(|s| format!("rpc:{s}?aud=*"))
                .collect::<Vec<_>>()
                .join(" ")
        );
        assert!(missing_capabilities(Some(&cli), &wisp_cli_required_capabilities()).is_empty());
        let app = "atproto repo:place.wisp.fs repo:place.wisp.domain repo:place.wisp.subfs repo:place.wisp.settings repo:place.wisp.v2.wh blob:*/*";
        assert!(missing_capabilities(Some(app), &wisp_app_required_capabilities()).is_empty());
    }
    #[test]
    fn required_capabilities_are_no_broader_than_the_sets() {
        let grants = [
            permission_set_capabilities(WISP_PERMISSION_SET_SITES).unwrap(),
            permission_set_capabilities(WISP_PERMISSION_SET_HOSTING).unwrap(),
            vec![blob("*/*")],
        ]
        .concat();
        assert!(
            wisp_cli_required_capabilities()
                .iter()
                .all(|c| grants.contains(c))
        );
    }
    #[test]
    fn descriptions() {
        assert_eq!(
            describe_capability(&repo("delete")),
            "delete place.wisp.fs records"
        );
        assert_eq!(
            describe_capability(&rpc("*")),
            "call place.wisp.v2.site.getList"
        );
        assert_eq!(describe_capability(&blob("*/*")), "upload */* blobs");
    }
}
