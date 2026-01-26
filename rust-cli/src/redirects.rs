use regex::Regex;
use std::collections::HashMap;
use std::fs;
use std::path::Path;

/// Maximum number of redirect rules to prevent DoS attacks
const MAX_REDIRECT_RULES: usize = 1000;

#[derive(Debug, Clone)]
pub struct RedirectRule {
    #[allow(dead_code)]
    pub from: String,
    pub to: String,
    pub status: u16,
    #[allow(dead_code)]
    pub force: bool,
    pub from_pattern: Regex,
    pub from_params: Vec<String>,
    pub query_params: Option<HashMap<String, String>>,
}

#[derive(Debug)]
pub struct RedirectMatch {
    pub target_path: String,
    pub status: u16,
    pub force: bool,
}

/// Parse a _redirects file into an array of redirect rules
pub fn parse_redirects_file(content: &str) -> Vec<RedirectRule> {
    let lines = content.lines();
    let mut rules = Vec::new();

    for (line_num, line_raw) in lines.enumerate() {
        if line_raw.trim().is_empty() || line_raw.trim().starts_with('#') {
            continue;
        }

        // Enforce max rules limit
        if rules.len() >= MAX_REDIRECT_RULES {
            eprintln!(
                "Redirect rules limit reached ({}), ignoring remaining rules",
                MAX_REDIRECT_RULES
            );
            break;
        }

        match parse_redirect_line(line_raw.trim()) {
            Ok(Some(rule)) => rules.push(rule),
            Ok(None) => continue,
            Err(e) => {
                eprintln!(
                    "Failed to parse redirect rule on line {}: {} ({})",
                    line_num + 1,
                    line_raw,
                    e
                );
            }
        }
    }

    rules
}

/// Parse a single redirect rule line
/// Format: /from [query_params] /to [status] [conditions]
fn parse_redirect_line(line: &str) -> Result<Option<RedirectRule>, String> {
    let parts: Vec<&str> = line.split_whitespace().collect();

    if parts.len() < 2 {
        return Ok(None);
    }

    let mut idx = 0;
    let from = parts[idx];
    idx += 1;

    let mut status = 301; // Default status
    let mut force = false;
    let mut query_params: HashMap<String, String> = HashMap::new();

    // Parse query parameters that come before the destination path
    while idx < parts.len() {
        let part = parts[idx];

        // If it starts with / or http, it's the destination path
        if part.starts_with('/') || part.starts_with("http://") || part.starts_with("https://") {
            break;
        }

        // If it contains = and comes before the destination, it's a query param
        if part.contains('=') {
            let split_index = part.find('=').unwrap();
            let key = &part[..split_index];
            let value = &part[split_index + 1..];

            if !key.is_empty() && !value.is_empty() {
                query_params.insert(key.to_string(), value.to_string());
            }
            idx += 1;
        } else {
            break;
        }
    }

    // Next part should be the destination
    if idx >= parts.len() {
        return Ok(None);
    }

    let to = parts[idx];
    idx += 1;

    // Parse remaining parts for status code
    for part in parts.iter().skip(idx) {
        // Check for status code (with optional ! for force)
        if let Some(stripped) = part.strip_suffix('!') {
            if let Ok(s) = stripped.parse::<u16>() {
                force = true;
                status = s;
            }
        } else if let Ok(s) = part.parse::<u16>() {
            status = s;
        }
        // Note: We're ignoring conditional redirects (Country, Language, Cookie, Role) for now
        // They can be added later if needed
    }

    // Parse the 'from' pattern
    let (pattern, params) = convert_path_to_regex(from)?;

    Ok(Some(RedirectRule {
        from: from.to_string(),
        to: to.to_string(),
        status,
        force,
        from_pattern: pattern,
        from_params: params,
        query_params: if query_params.is_empty() {
            None
        } else {
            Some(query_params)
        },
    }))
}

/// Convert a path pattern with placeholders and splats to a regex
/// Examples:
///   /blog/:year/:month/:day -> captures year, month, day
///   /news/* -> captures splat
fn convert_path_to_regex(pattern: &str) -> Result<(Regex, Vec<String>), String> {
    let mut params = Vec::new();
    let mut regex_str = String::from("^");

    // Split by query string if present
    let path_part = pattern.split('?').next().unwrap_or(pattern);

    // Escape special regex characters except * and :
    let mut escaped = String::new();
    for ch in path_part.chars() {
        match ch {
            '.' | '+' | '^' | '$' | '{' | '}' | '(' | ')' | '|' | '[' | ']' | '\\' => {
                escaped.push('\\');
                escaped.push(ch);
            }
            _ => escaped.push(ch),
        }
    }

    // Replace :param with named capture groups
    let param_regex = Regex::new(r":([a-zA-Z_][a-zA-Z0-9_]*)").map_err(|e| e.to_string())?;
    let mut last_end = 0;
    let mut result = String::new();

    for cap in param_regex.captures_iter(&escaped) {
        let m = cap.get(0).unwrap();
        result.push_str(&escaped[last_end..m.start()]);
        result.push_str("([^/?]+)");
        params.push(cap[1].to_string());
        last_end = m.end();
    }
    result.push_str(&escaped[last_end..]);
    escaped = result;

    // Replace * with splat capture
    if escaped.contains('*') {
        escaped = escaped.replace('*', "(.*)");
        params.push("splat".to_string());
    }

    regex_str.push_str(&escaped);

    // Make trailing slash optional
    if !regex_str.ends_with(".*") {
        regex_str.push_str("/?");
    }

    regex_str.push('$');

    let pattern = Regex::new(&regex_str).map_err(|e| e.to_string())?;

    Ok((pattern, params))
}

/// Match a request path against redirect rules
pub fn match_redirect_rule(
    request_path: &str,
    rules: &[RedirectRule],
    query_params: Option<&HashMap<String, String>>,
) -> Option<RedirectMatch> {
    // Normalize path: ensure leading slash
    let normalized_path = if request_path.starts_with('/') {
        request_path.to_string()
    } else {
        format!("/{}", request_path)
    };

    for rule in rules {
        // Check query parameter conditions first (if any)
        if let Some(required_params) = &rule.query_params {
            if let Some(actual_params) = query_params {
                let query_matches = required_params.iter().all(|(key, expected_value)| {
                    if let Some(actual_value) = actual_params.get(key) {
                        // If expected value is a placeholder (:name), any value is acceptable
                        if expected_value.starts_with(':') {
                            return true;
                        }
                        // Otherwise it must match exactly
                        actual_value == expected_value
                    } else {
                        false
                    }
                });

                if !query_matches {
                    continue;
                }
            } else {
                // Rule requires query params but none provided
                continue;
            }
        }

        // Match the path pattern
        if let Some(captures) = rule.from_pattern.captures(&normalized_path) {
            let mut target_path = rule.to.clone();

            // Replace captured parameters
            for (i, param_name) in rule.from_params.iter().enumerate() {
                if let Some(param_value) = captures.get(i + 1) {
                    let value = param_value.as_str();

                    if param_name == "splat" {
                        target_path = target_path.replace(":splat", value);
                    } else {
                        target_path = target_path.replace(&format!(":{}", param_name), value);
                    }
                }
            }

            // Handle query parameter replacements
            if let Some(required_params) = &rule.query_params {
                if let Some(actual_params) = query_params {
                    for (key, placeholder) in required_params {
                        if placeholder.starts_with(':') {
                            if let Some(actual_value) = actual_params.get(key) {
                                let param_name = &placeholder[1..];
                                target_path = target_path.replace(
                                    &format!(":{}", param_name),
                                    actual_value,
                                );
                            }
                        }
                    }
                }
            }

            // Preserve query string for 200, 301, 302 redirects (unless target already has one)
            if [200, 301, 302].contains(&rule.status)
                && query_params.is_some()
                && !target_path.contains('?')
            {
                if let Some(params) = query_params {
                    if !params.is_empty() {
                        let query_string: String = params
                            .iter()
                            .map(|(k, v)| format!("{}={}", k, v))
                            .collect::<Vec<_>>()
                            .join("&");
                        target_path = format!("{}?{}", target_path, query_string);
                    }
                }
            }

            return Some(RedirectMatch {
                target_path,
                status: rule.status,
                force: rule.force,
            });
        }
    }

    None
}

/// Load redirect rules from a _redirects file
pub fn load_redirect_rules(directory: &Path) -> Vec<RedirectRule> {
    let redirects_path = directory.join("_redirects");

    if !redirects_path.exists() {
        return Vec::new();
    }

    match fs::read_to_string(&redirects_path) {
        Ok(content) => parse_redirects_file(&content),
        Err(e) => {
            eprintln!("Failed to load _redirects file: {}", e);
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_simple_redirect() {
        let content = "/old-path /new-path";
        let rules = parse_redirects_file(content);
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].from, "/old-path");
        assert_eq!(rules[0].to, "/new-path");
        assert_eq!(rules[0].status, 301);
        assert!(!rules[0].force);
    }

    #[test]
    fn test_parse_with_status() {
        let content = "/temp /target 302";
        let rules = parse_redirects_file(content);
        assert_eq!(rules[0].status, 302);
    }

    #[test]
    fn test_parse_force_redirect() {
        let content = "/force /target 301!";
        let rules = parse_redirects_file(content);
        assert!(rules[0].force);
    }

    #[test]
    fn test_match_exact_path() {
        let rules = parse_redirects_file("/old-path /new-path");
        let m = match_redirect_rule("/old-path", &rules, None);
        assert!(m.is_some());
        assert_eq!(m.unwrap().target_path, "/new-path");
    }

    #[test]
    fn test_match_splat() {
        let rules = parse_redirects_file("/news/* /blog/:splat");
        let m = match_redirect_rule("/news/2024/01/15/post", &rules, None);
        assert!(m.is_some());
        assert_eq!(m.unwrap().target_path, "/blog/2024/01/15/post");
    }

    #[test]
    fn test_match_placeholders() {
        let rules = parse_redirects_file("/blog/:year/:month/:day /posts/:year-:month-:day");
        let m = match_redirect_rule("/blog/2024/01/15", &rules, None);
        assert!(m.is_some());
        assert_eq!(m.unwrap().target_path, "/posts/2024-01-15");
    }
}
