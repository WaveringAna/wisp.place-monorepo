/**
 * Simple tests for HTML path rewriter
 * Run with: bun test
 */

import { test, expect } from 'bun:test';
import { rewriteHtmlPaths, isHtmlContent } from './html-rewriter';

test('rewriteHtmlPaths - rewrites absolute paths in src attributes', () => {
  const html = '<img src="/logo.png">';
  const result = rewriteHtmlPaths(html, '/did:plc:123/mysite/');
  expect(result).toBe('<img src="/did:plc:123/mysite/logo.png">');
});

test('rewriteHtmlPaths - rewrites absolute paths in href attributes', () => {
  const html = '<link rel="stylesheet" href="/style.css">';
  const result = rewriteHtmlPaths(html, '/did:plc:123/mysite/');
  expect(result).toBe('<link rel="stylesheet" href="/did:plc:123/mysite/style.css">');
});

test('rewriteHtmlPaths - preserves external URLs', () => {
  const html = '<img src="https://example.com/logo.png">';
  const result = rewriteHtmlPaths(html, '/did:plc:123/mysite/');
  expect(result).toBe('<img src="https://example.com/logo.png">');
});

test('rewriteHtmlPaths - preserves protocol-relative URLs', () => {
  const html = '<script src="//cdn.example.com/script.js"></script>';
  const result = rewriteHtmlPaths(html, '/did:plc:123/mysite/');
  expect(result).toBe('<script src="//cdn.example.com/script.js"></script>');
});

test('rewriteHtmlPaths - preserves data URIs', () => {
  const html = '<img src="data:image/png;base64,abc123">';
  const result = rewriteHtmlPaths(html, '/did:plc:123/mysite/');
  expect(result).toBe('<img src="data:image/png;base64,abc123">');
});

test('rewriteHtmlPaths - preserves anchors', () => {
  const html = '<a href="/#section">Jump</a>';
  const result = rewriteHtmlPaths(html, '/did:plc:123/mysite/');
  expect(result).toBe('<a href="/#section">Jump</a>');
});

test('rewriteHtmlPaths - preserves relative paths', () => {
  const html = '<img src="./logo.png">';
  const result = rewriteHtmlPaths(html, '/did:plc:123/mysite/');
  expect(result).toBe('<img src="./logo.png">');
});

test('rewriteHtmlPaths - handles single quotes', () => {
  const html = "<img src='/logo.png'>";
  const result = rewriteHtmlPaths(html, '/did:plc:123/mysite/');
  expect(result).toBe("<img src='/did:plc:123/mysite/logo.png'>");
});

test('rewriteHtmlPaths - handles srcset', () => {
  const html = '<img srcset="/logo.png 1x, /logo@2x.png 2x">';
  const result = rewriteHtmlPaths(html, '/did:plc:123/mysite/');
  expect(result).toBe('<img srcset="/did:plc:123/mysite/logo.png 1x, /did:plc:123/mysite/logo@2x.png 2x">');
});

test('rewriteHtmlPaths - handles form actions', () => {
  const html = '<form action="/submit"></form>';
  const result = rewriteHtmlPaths(html, '/did:plc:123/mysite/');
  expect(result).toBe('<form action="/did:plc:123/mysite/submit"></form>');
});

test('rewriteHtmlPaths - handles complex HTML', () => {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="/style.css">
  <script src="/app.js"></script>
</head>
<body>
  <img src="/images/logo.png" srcset="/images/logo.png 1x, /images/logo@2x.png 2x">
  <a href="/about">About</a>
  <a href="https://example.com">External</a>
  <a href="#section">Anchor</a>
</body>
</html>
  `.trim();

  const result = rewriteHtmlPaths(html, '/did:plc:123/mysite/');

  expect(result).toContain('href="/did:plc:123/mysite/style.css"');
  expect(result).toContain('src="/did:plc:123/mysite/app.js"');
  expect(result).toContain('src="/did:plc:123/mysite/images/logo.png"');
  expect(result).toContain('href="/did:plc:123/mysite/about"');
  expect(result).toContain('href="https://example.com"'); // External preserved
  expect(result).toContain('href="#section"'); // Anchor preserved
});

test('isHtmlContent - detects HTML by extension', () => {
  expect(isHtmlContent('index.html')).toBe(true);
  expect(isHtmlContent('page.htm')).toBe(true);
  expect(isHtmlContent('style.css')).toBe(false);
  expect(isHtmlContent('script.js')).toBe(false);
});

test('isHtmlContent - detects HTML by content type', () => {
  expect(isHtmlContent('index', 'text/html')).toBe(true);
  expect(isHtmlContent('index', 'text/html; charset=utf-8')).toBe(true);
  expect(isHtmlContent('index', 'application/json')).toBe(false);
});
