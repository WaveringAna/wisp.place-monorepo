//! Bounded, token-based Netlify-style `_redirects` parsing and matching.
use std::collections::HashSet;

pub const MAX_REDIRECT_FILE_BYTES: usize = 1_000_000;
/// Ordered records preserve JavaScript's query-string insertion order.
pub type StringRecord = Vec<(String, String)>;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Conditions {
    pub country: Option<Vec<String>>,
    pub language: Option<Vec<String>>,
    pub role: Option<Vec<String>>,
    pub cookie: Option<Vec<String>>,
}
#[derive(Clone, Debug)]
pub struct RedirectRule {
    pub from: String,
    pub to: String,
    pub status: u16,
    pub force: bool,
    pub conditions: Conditions,
    pub query_params: StringRecord,
    compiled: CompiledPath,
}
#[derive(Clone, Debug, Default)]
pub struct MatchRedirectContext {
    pub query_params: StringRecord,
    pub headers: StringRecord,
    pub cookies: StringRecord,
}
#[derive(Debug)]
pub struct RedirectMatch<'a> {
    pub rule: &'a RedirectRule,
    pub target_path: String,
    pub status: u16,
}
#[derive(Clone, Debug)]
struct Segment {
    prefix: String,
    param: Option<String>,
    suffix: String,
}
#[derive(Clone, Debug)]
struct CompiledPath {
    segments: Vec<Segment>,
    params: Vec<String>,
    splat: Option<(String, bool)>,
}
fn js_whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
fn js_trim(value: &str) -> &str {
    value.trim_matches(js_whitespace)
}
fn js_len(value: &str) -> usize {
    value.encode_utf16().count()
}
fn get<'a>(record: &'a StringRecord, key: &str) -> Option<&'a str> {
    record
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
}
fn set(record: &mut StringRecord, key: String, value: String, bounded: bool) {
    if let Some((_, old)) = record.iter_mut().find(|(k, _)| *k == key) {
        *old = value;
    } else if !bounded || (!key.is_empty() && record.len() < 32) {
        // Object.entries enumerates canonical array-index keys before strings.
        let index_key = |key: &str| {
            key.parse::<u32>()
                .ok()
                .filter(|n| *n != u32::MAX && n.to_string() == key)
        };
        let position = index_key(&key)
            .map(|index| {
                record
                    .iter()
                    .position(|(k, _)| index_key(k).is_none_or(|n| n > index))
                    .unwrap_or(record.len())
            })
            .unwrap_or(record.len());
        record.insert(position, (key, value));
    }
}
fn safe_decode(value: &str) -> String {
    let mut bytes = Vec::with_capacity(value.len());
    let mut input = value.as_bytes().iter().copied();
    while let Some(byte) = input.next() {
        if byte == b'%' {
            let Some(high) = input.next().and_then(|v| (v as char).to_digit(16)) else {
                return value.into();
            };
            let Some(low) = input.next().and_then(|v| (v as char).to_digit(16)) else {
                return value.into();
            };
            bytes.push((high * 16 + low) as u8);
        } else {
            bytes.push(byte);
        }
    }
    String::from_utf8(bytes).unwrap_or_else(|_| value.into())
}
pub(crate) fn encode_component(value: &str, strict: bool) -> String {
    value
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric()
                || b"-_.~".contains(&b)
                || (!strict && b"!'()*".contains(&b))
            {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
pub fn parse_query_string(url: &str) -> StringRecord {
    let mut result = Vec::new();
    if let Some((_, query)) = url.split_once('?') {
        for pair in query.split('&').filter(|v| !v.is_empty()) {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            if !key.is_empty() {
                set(&mut result, safe_decode(key), safe_decode(value), true);
            }
        }
    }
    result
}
pub fn parse_cookies(header: Option<&str>) -> StringRecord {
    let mut result = Vec::new();
    for part in header.unwrap_or("").split(';') {
        if let Some((key, value)) = part.split_once('=')
            && !key.is_empty()
        {
            set(
                &mut result,
                js_trim(key).into(),
                js_trim(value).into(),
                false,
            );
        }
    }
    result
}
pub fn parse_redirects_file_bytes(data: &[u8]) -> Option<Vec<RedirectRule>> {
    parse_redirects_file_bytes_with(data, |bytes| {
        String::from_utf8_lossy(bytes)
            .trim_start_matches('\u{feff}')
            .into()
    })
}
pub fn parse_redirects_file_bytes_with(
    data: &[u8],
    decode: impl FnOnce(&[u8]) -> String,
) -> Option<Vec<RedirectRule>> {
    (data.len() <= MAX_REDIRECT_FILE_BYTES).then(|| parse_redirects_file(&decode(data)))
}
pub fn parse_redirects_file(content: &str) -> Vec<RedirectRule> {
    let mut units = 0;
    let end = content.char_indices().find_map(|(i, c)| {
        units += c.len_utf16();
        (units > MAX_REDIRECT_FILE_BYTES).then_some(i)
    });
    let limited = &content[..end.unwrap_or(content.len())];
    let limited = if end.is_some() && !limited.ends_with('\n') {
        limited.rsplit_once('\n').map_or("", |(head, _)| head)
    } else {
        limited
    };
    limited
        .split('\n')
        .filter(|line| js_len(line) <= 8192)
        .map(js_trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(parse_line)
        .take(1000)
        .collect()
}
fn parse_line(line: &str) -> Option<RedirectRule> {
    let mut parts = line.split(js_whitespace).filter(|v| !v.is_empty());
    let from = parts.next()?;
    let mut query_params = Vec::new();
    if let Some((_, query)) = from.split_once('?') {
        for pair in query.split('&') {
            if let Some((key, value)) = pair.split_once('=')
                && !key.is_empty()
                && !value.is_empty()
            {
                set(
                    &mut query_params,
                    safe_decode(key),
                    safe_decode(value),
                    true,
                );
            }
        }
    }
    let to = loop {
        let part = parts.next()?;
        if part.starts_with('/') || part.starts_with("http://") || part.starts_with("https://") {
            break part;
        }
        let Some((key, value)) = part.split_once('=') else {
            break part;
        };
        if !key.is_empty() && !value.is_empty() {
            set(&mut query_params, key.into(), value.into(), true);
        }
    };
    let mut status = 301;
    let mut force = false;
    let mut conditions = Conditions::default();
    for part in parts {
        let digits = part.strip_suffix('!').unwrap_or(part);
        if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
            force |= part.ends_with('!');
            status = digits.parse().ok()?;
        } else if let Some((key, value)) = part.split_once('=')
            && !value.is_empty()
        {
            let key = key.to_lowercase();
            let values = value
                .split(',')
                .map(|v| {
                    if key == "role" {
                        js_trim(v).into()
                    } else {
                        js_trim(v).to_lowercase()
                    }
                })
                .collect();
            match key.as_str() {
                "country" => conditions.country = Some(values),
                "language" => conditions.language = Some(values),
                "role" => conditions.role = Some(values),
                "cookie" => conditions.cookie = Some(values),
                _ => {}
            }
        }
    }
    Some(RedirectRule {
        from: from.into(),
        to: to.into(),
        status,
        force,
        conditions,
        query_params,
        compiled: compile_path(from)?,
    })
}
fn parse_segment(segment: &str, params: &mut Vec<String>) -> Option<Segment> {
    let mut placeholder = None;
    let bytes = segment.as_bytes();
    for (i, byte) in bytes.iter().enumerate() {
        if *byte != b':'
            || !bytes
                .get(i + 1)
                .is_some_and(|b| b.is_ascii_alphabetic() || *b == b'_')
        {
            continue;
        }
        if placeholder.is_some() {
            return None;
        }
        let end = (i + 1..bytes.len())
            .find(|&j| !bytes[j].is_ascii_alphanumeric() && bytes[j] != b'_')
            .unwrap_or(bytes.len());
        placeholder = Some((i, end));
    }
    if let Some((start, end)) = placeholder {
        if params.len() >= 32 {
            return None;
        }
        let name = segment[start + 1..end].to_owned();
        params.push(name.clone());
        Some(Segment {
            prefix: segment[..start].into(),
            param: Some(name),
            suffix: segment[end..].into(),
        })
    } else {
        Some(Segment {
            prefix: segment.into(),
            param: None,
            suffix: String::new(),
        })
    }
}
fn parse_segments(path: &str, params: &mut Vec<String>) -> Option<Vec<Segment>> {
    let pieces: Vec<_> = path.split('/').collect();
    if pieces.len() > 128 {
        return None;
    }
    pieces
        .into_iter()
        .map(|p| parse_segment(p, params))
        .collect()
}
fn compile_path(from: &str) -> Option<CompiledPath> {
    let path = from.split('?').next()?;
    if path.is_empty() || js_len(path) > 2048 {
        return None;
    }
    let mut params = Vec::new();
    let (segments, splat) = if let Some(star) = path.find('*') {
        if star != path.len() - 1 {
            return None;
        }
        let before = &path[..star];
        let (segments, prefix, separator) = if let Some((head, tail)) = before.rsplit_once('/') {
            (parse_segments(head, &mut params)?, tail, true)
        } else {
            (Vec::new(), before, false)
        };
        if parse_segment(prefix, &mut params)?.param.is_some() || params.len() >= 32 {
            return None;
        }
        params.push("splat".into());
        (segments, Some((prefix.into(), separator)))
    } else {
        (parse_segments(path, &mut params)?, None)
    };
    Some(CompiledPath {
        segments,
        params,
        splat,
    })
}
fn match_segments(pattern: &[Segment], request: &[&str], complete: bool) -> Option<Vec<String>> {
    if request.len() < pattern.len() || (complete && request.len() != pattern.len()) {
        return None;
    }
    pattern
        .iter()
        .zip(request)
        .try_fold(Vec::new(), |mut captures, (segment, value)| {
            if segment.param.is_none() {
                if *value != segment.prefix {
                    return None;
                }
            } else {
                let capture = value
                    .strip_prefix(&segment.prefix)?
                    .strip_suffix(&segment.suffix)?;
                if capture.is_empty() || capture.contains('?') {
                    return None;
                }
                captures.push(capture.into());
            }
            Some(captures)
        })
}
fn match_path(compiled: &CompiledPath, path: &str, request: &[&str]) -> Option<Vec<String>> {
    if let Some((prefix, separator)) = &compiled.splat {
        let mut captures = match_segments(&compiled.segments, request, false)?;
        let start = request[..compiled.segments.len()].join("/").len();
        let remaining = path.get(start..)?;
        let remaining = if *separator {
            remaining.strip_prefix('/')?
        } else {
            remaining
        };
        captures.push(remaining.strip_prefix(prefix)?.into());
        Some(captures)
    } else {
        match_segments(&compiled.segments, request, true).or_else(|| {
            (request.last() == Some(&""))
                .then(|| match_segments(&compiled.segments, &request[..request.len() - 1], true))
                .flatten()
        })
    }
}
fn matches_conditions(conditions: &Conditions, context: &MatchRedirectContext) -> bool {
    if conditions.role.is_some() {
        return false;
    }
    if let Some(countries) = &conditions.country {
        let country = get(&context.headers, "cf-ipcountry")
            .filter(|v| !v.is_empty())
            .or_else(|| get(&context.headers, "x-country"));
        if !country.is_some_and(|v| countries.contains(&v.to_lowercase())) {
            return false;
        }
    }
    if let Some(languages) = &conditions.language {
        let Some(header) = get(&context.headers, "accept-language").filter(|v| !v.is_empty())
        else {
            return false;
        };
        if !header
            .split(',')
            .map(|v| js_trim(v.split(';').next().unwrap_or("")).to_lowercase())
            .filter(|v| !v.is_empty())
            .any(|v| {
                languages
                    .iter()
                    .any(|lang| v == *lang || v.starts_with(&format!("{lang}-")))
            })
        {
            return false;
        }
    }
    if let Some(cookies) = &conditions.cookie
        && !cookies
            .iter()
            .any(|key| get(&context.cookies, key).is_some())
    {
        return false;
    }
    true
}
pub fn match_redirect_rule<'a>(
    request_path: &str,
    rules: &'a [RedirectRule],
    context: Option<&MatchRedirectContext>,
) -> Option<RedirectMatch<'a>> {
    match_redirect_rule_with_visited(request_path, rules, context, &mut HashSet::new())
}
pub fn match_redirect_rule_with_visited<'a>(
    request_path: &str,
    rules: &'a [RedirectRule],
    context: Option<&MatchRedirectContext>,
    visited: &mut HashSet<String>,
) -> Option<RedirectMatch<'a>> {
    let path = if request_path.starts_with('/') {
        request_path.to_owned()
    } else {
        format!("/{request_path}")
    };
    if js_len(&path) > 8192 || !visited.insert(path.clone()) || visited.len() > 10 {
        return None;
    }
    let empty = MatchRedirectContext::default();
    let context = context.unwrap_or(&empty);
    let segments: Vec<_> = path.split('/').collect();
    for rule in rules {
        if !rule.query_params.iter().all(|(key, value)| {
            get(&context.query_params, key)
                .is_some_and(|v| value.is_empty() || value.starts_with(':') || v == value)
        }) || !matches_conditions(&rule.conditions, context)
        {
            continue;
        }
        let Some(captures) = match_path(&rule.compiled, &path, &segments) else {
            continue;
        };
        let mut target = rule.to.clone();
        for (param, value) in rule.compiled.params.iter().zip(captures) {
            let encoded = encode_component(&value, false);
            let encoded = if param == "splat" {
                encoded.replace("%2F", "/")
            } else {
                encoded
            };
            target = target.replacen(&format!(":{param}"), &encoded, 1);
        }
        for (key, placeholder) in &rule.query_params {
            if let Some(param) = placeholder.strip_prefix(':').filter(|v| !v.is_empty())
                && let Some(value) = get(&context.query_params, key).filter(|v| !v.is_empty())
            {
                target = target.replacen(&format!(":{param}"), &encode_component(value, false), 1);
            }
        }
        if [200, 301, 302].contains(&rule.status)
            && !target.contains('?')
            && !context.query_params.is_empty()
        {
            let query = context
                .query_params
                .iter()
                .map(|(k, v)| {
                    format!(
                        "{}={}",
                        encode_component(k, false),
                        encode_component(v, false)
                    )
                })
                .collect::<Vec<_>>()
                .join("&");
            target.push('?');
            target.push_str(&query);
        }
        return Some(RedirectMatch {
            rule,
            target_path: target,
            status: rule.status,
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    fn context(
        query: &[(&str, &str)],
        headers: &[(&str, &str)],
        cookies: &[(&str, &str)],
    ) -> MatchRedirectContext {
        let pairs = |p: &[(&str, &str)]| {
            p.iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect()
        };
        MatchRedirectContext {
            query_params: pairs(query),
            headers: pairs(headers),
            cookies: pairs(cookies),
        }
    }
    fn target(
        source: &str,
        path: &str,
        context: Option<&MatchRedirectContext>,
    ) -> Option<(String, u16)> {
        match_redirect_rule(path, &parse_redirects_file(source), context)
            .map(|m| (m.target_path, m.status))
    }
    #[test]
    fn parse_simple_statuses_force_and_placeholders() {
        let rules = parse_redirects_file(
            "\n# comment\n/old-path /new-path\n/home / 301\n/temp /target 302\n/rewrite /content 200\n/not-found /404 404\n/force /target 301!\n/news/* /blog/:splat\n/blog/:year/:month/:day /posts/:year-:month-:day",
        );
        assert_eq!(rules.len(), 8);
        assert_eq!(rules[0].from, "/old-path");
        assert_eq!(rules[0].to, "/new-path");
        assert_eq!(
            rules.iter().map(|r| r.status).collect::<Vec<_>>(),
            vec![301, 301, 302, 200, 404, 301, 301, 301]
        );
        assert!(!rules[0].force);
        assert!(rules[5].force);
        assert_eq!(rules[6].from, "/news/*");
        assert_eq!(rules[7].to, "/posts/:year-:month-:day");
    }
    #[test]
    fn parse_conditions() {
        let rules = parse_redirects_file(
            "/ /anz 302 Country=AU,nz\n/products /en/products 301 Language=EN\n/* /legacy/:splat 200 Cookie=is_legacy,my_cookie\n/ /role Role=Admin,user",
        );
        assert_eq!(rules[0].conditions.country.as_ref().unwrap(), &["au", "nz"]);
        assert_eq!(rules[1].conditions.language.as_ref().unwrap(), &["en"]);
        assert_eq!(
            rules[2].conditions.cookie.as_ref().unwrap(),
            &["is_legacy", "my_cookie"]
        );
        assert_eq!(
            rules[3].conditions.role.as_ref().unwrap(),
            &["Admin", "user"]
        );
        assert_eq!(target("/ /role Role=Admin", "/", None), None);
    }
    #[test]
    fn exact_trailing_splat_and_named_paths() {
        for (source, path, expected, status) in [
            ("/old-path /new-path", "/old-path", "/new-path", 301),
            ("/old-path /new-path", "/old-path/", "/new-path", 301),
            ("/old-path /new-path", "old-path", "/new-path", 301),
            (
                "/news/* /blog/:splat",
                "/news/2024/01/15/my-post",
                "/blog/2024/01/15/my-post",
                301,
            ),
            (
                "/blog/:year/:month/:day /posts/:year-:month-:day",
                "/blog/2024/01/15",
                "/posts/2024-01-15",
                301,
            ),
            ("/* /index.html 200", "/about", "/index.html", 200),
            (
                "/* /index.html 200",
                "/users/123/profile",
                "/index.html",
                200,
            ),
            ("/* /index.html 200", "/", "/index.html", 200),
            (
                "/files/pre:id.txt /:id",
                "/files/prehello.txt",
                "/hello",
                301,
            ),
            ("/pre* /:splat", "/prefix/part", "/fix/part", 301),
        ] {
            assert_eq!(
                target(source, path, None),
                Some((expected.into(), status)),
                "{source}: {path}"
            );
        }
        assert_eq!(target("/x/:id /:id", "/x/", None), None);
        assert_eq!(target("/x/:id /:id", "/x/a?b", None), None);
        assert_eq!(target("/x/ /ok", "/x", None), None);
    }
    #[test]
    fn first_rule_and_specific_before_general() {
        assert_eq!(
            target("/path /first\n/path /second", "/path", None)
                .unwrap()
                .0,
            "/first"
        );
        let rules = "/jobs/customer-ninja /careers/support\n/jobs/* /careers/:splat";
        assert_eq!(
            target(rules, "/jobs/customer-ninja", None).unwrap().0,
            "/careers/support"
        );
        assert_eq!(
            target(rules, "/jobs/developer", None).unwrap().0,
            "/careers/developer"
        );
    }
    #[test]
    fn query_preservation_matching_and_encoding() {
        let ctx = context(&[("foo", "bar"), ("baz", "qux")], &[], &[]);
        for status in [200, 301, 302] {
            assert_eq!(
                target(&format!("/old /new {status}"), "/old", Some(&ctx))
                    .unwrap()
                    .0,
                "/new?foo=bar&baz=qux"
            );
        }
        assert_eq!(
            target("/old /new 404", "/old", Some(&ctx)).unwrap().0,
            "/new"
        );
        let ctx = context(&[("id", "my-post")], &[], &[]);
        assert_eq!(
            target("/store id=:id /blog/:id 301", "/store", Some(&ctx))
                .unwrap()
                .0,
            "/blog/my-post?id=my-post"
        );
        assert_eq!(
            target(
                "/store id=:id /blog/:id 301",
                "/store",
                Some(&MatchRedirectContext::default())
            ),
            None
        );
        let ctx = context(&[("resource", "acct:ana@example.com")], &[], &[]);
        assert_eq!(
            target(
                "/.well-known/webfinger?resource=:resource https://webfinger.example.com/?resource=:resource 200",
                "/.well-known/webfinger",
                Some(&ctx)
            ),
            Some((
                "https://webfinger.example.com/?resource=acct%3Aana%40example.com".into(),
                200
            ))
        );
        assert_eq!(
            target("/:id /:id", "/a%20é", None).unwrap().0,
            "/a%2520%C3%A9"
        );
        assert_eq!(
            target("/* /:splat", "/a b/é", None).unwrap().0,
            "/a%20b/%C3%A9"
        );
        assert_eq!(target("/x?key=literal /target", "/x", Some(&ctx)), None);
    }
    #[test]
    fn country_language_cookie_context() {
        let ctx = context(&[], &[("cf-ipcountry", "AU")], &[]);
        assert_eq!(
            target("/ /aus 302 Country=au", "/", Some(&ctx)).unwrap().0,
            "/aus"
        );
        assert_eq!(
            target(
                "/ /aus 302 Country=au",
                "/",
                Some(&context(&[], &[("cf-ipcountry", "US")], &[]))
            ),
            None
        );
        assert_eq!(
            target(
                "/ /aus Country=au",
                "/",
                Some(&context(&[], &[("x-country", "AU")], &[]))
            )
            .unwrap()
            .0,
            "/aus"
        );
        let ctx = context(&[], &[("accept-language", "en-US,en;q=0.9")], &[]);
        assert_eq!(
            target(
                "/products /en/products 301 Language=en",
                "/products",
                Some(&ctx)
            )
            .unwrap()
            .0,
            "/en/products"
        );
        assert_eq!(
            target("/products /en/products Language=en", "/products", None),
            None
        );
        let ctx = context(&[], &[], &[("is_legacy", "true")]);
        assert_eq!(
            target(
                "/* /legacy/:splat 200 Cookie=is_legacy",
                "/some-path",
                Some(&ctx)
            )
            .unwrap()
            .0,
            "/legacy/some-path"
        );
        assert_eq!(
            target("/* /legacy/:splat Cookie=is_legacy", "/some-path", None),
            None
        );
    }
    #[test]
    fn byte_limit_checked_before_decoding() {
        let large = vec![0; MAX_REDIRECT_FILE_BYTES + 1024];
        assert!(parse_redirects_file_bytes_with(&large, |_| panic!("must not decode")).is_none());
        let exact = vec![0; MAX_REDIRECT_FILE_BYTES];
        let rules = parse_redirects_file_bytes_with(&exact, |bytes| {
            assert_eq!(bytes.len(), MAX_REDIRECT_FILE_BYTES);
            "/old /new 301".into()
        })
        .unwrap();
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].status, 301);
        assert_eq!(
            parse_redirects_file_bytes(b"\xef\xbb\xbf/old /new")
                .unwrap()
                .len(),
            1
        );
    }
    #[test]
    fn rejects_ambiguous_patterns_and_bounds_work() {
        assert_eq!(
            parse_redirects_file(
                "/safe/* /target/:splat\n/nested/*/suffix /target\n/*/*/*/*/*/*/*/*/x /target"
            )
            .len(),
            1
        );
        let adjacent = (0..32).map(|i| format!(":part{i}")).collect::<String>();
        assert!(parse_redirects_file(&format!("/{adjacent}/expected /target")).is_empty());
        let bounded = (0..32)
            .map(|i| format!(":part{i}"))
            .collect::<Vec<_>>()
            .join("/");
        let path = format!("/{}/actual", vec!["x".repeat(180); 32].join("/"));
        let start = std::time::Instant::now();
        assert_eq!(
            target(&format!("/{bounded}/expected /target"), &path, None),
            None
        );
        assert!(start.elapsed() < std::time::Duration::from_millis(250));
        assert!(parse_redirects_file("/:id* /target").is_empty());
        assert!(parse_redirects_file(&format!("/{} /target", "x".repeat(2048))).is_empty());
        assert!(parse_redirects_file(&format!("/{} /target", vec!["x"; 128].join("/"))).is_empty());
        assert_eq!(parse_redirects_file(&"/x /y\n".repeat(1001)).len(), 1000);
        assert_eq!(target("/* /ok", &"x".repeat(8192), None), None);
    }
    #[test]
    fn truncated_file_drops_partial_final_rule() {
        let retained = "/kept /target 301\n";
        let final_rule = "/partial /must-not-apply 302";
        let comment_len = MAX_REDIRECT_FILE_BYTES - retained.len() - final_rule.len() - 2;
        let content = format!(
            "{retained}#{}\n{final_rule} trailing bytes",
            "x".repeat(comment_len)
        );
        let rules = parse_redirects_file(&content);
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].from, "/kept");
    }
    #[test]
    fn total_query_decoding_inline_and_cookie_parsing() {
        let params =
            parse_query_string("/search?malformed=%E0%A4%A&value=a=b=c&flag&empty=&=ignored");
        assert_eq!(get(&params, "malformed"), Some("%E0%A4%A"));
        assert_eq!(get(&params, "value"), Some("a=b=c"));
        assert_eq!(get(&params, "flag"), Some(""));
        assert_eq!(get(&params, "empty"), Some(""));
        assert_eq!(get(&params, ""), None);
        let ctx = MatchRedirectContext {
            query_params: params,
            ..Default::default()
        };
        assert_eq!(
            target(
                "/search?malformed=%E0%A4%A&value=a=b=c /target 404",
                "/search",
                Some(&ctx)
            )
            .unwrap()
            .0,
            "/target"
        );
        assert_eq!(
            parse_cookies(Some("x=a=b; flag; y= hello ;x=last")),
            vec![("x".into(), "last".into()), ("y".into(), "hello".into())]
        );
        assert!(parse_cookies(None).is_empty());
        assert_eq!(
            get(&parse_query_string("?x=a+b&%C3%A9=%F0%9F%99%82"), "x"),
            Some("a+b")
        );
    }
    #[test]
    fn query_cap_and_javascript_integer_order() {
        let query = (0..40)
            .map(|i| format!("k{i}=v"))
            .collect::<Vec<_>>()
            .join("&");
        assert_eq!(parse_query_string(&format!("?{query}")).len(), 32);
        let ctx = MatchRedirectContext {
            query_params: parse_query_string("?z=a&2=b&1=c&01=d"),
            ..Default::default()
        };
        assert_eq!(
            target("/ /target", "/", Some(&ctx)).unwrap().0,
            "/target?1=c&2=b&z=a&01=d"
        );
    }
    #[test]
    fn visited_path_and_chain_limit() {
        let rules = parse_redirects_file("/* /target");
        let mut visited = HashSet::new();
        assert!(match_redirect_rule_with_visited("/a", &rules, None, &mut visited).is_some());
        assert!(match_redirect_rule_with_visited("a", &rules, None, &mut visited).is_none());
        for i in 0..9 {
            assert!(
                match_redirect_rule_with_visited(&format!("/{i}"), &rules, None, &mut visited)
                    .is_some()
            );
        }
        assert!(match_redirect_rule_with_visited("/last", &rules, None, &mut visited).is_none());
    }
    #[test]
    fn javascript_whitespace_and_utf16_limits() {
        assert_eq!(
            parse_redirects_file("\u{feff}/x\u{feff}/y\u{feff}301").len(),
            1
        );
        assert!(parse_redirects_file("/x\u{0085}/y").is_empty());
        assert_eq!(
            parse_redirects_file(&format!("/{} /ok", "🙂".repeat(1023))).len(),
            1
        );
        assert!(parse_redirects_file(&format!("/{} /ok", "🙂".repeat(1024))).is_empty());
    }
}
