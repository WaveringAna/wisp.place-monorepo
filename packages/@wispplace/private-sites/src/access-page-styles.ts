/**
 * Shared styles for the standalone private-site access pages.
 *
 * The main-app sign-in page is the golden design; hosting-service interstitials use this
 * same string so the cross-origin handoff does not introduce a second visual language.
 */
export const PRIVATE_ACCESS_PAGE_STYLES = `
:root {
  color-scheme: light;
  --private-bg: oklch(0.92 0.012 35);
  --private-surface: oklch(0.95 0.008 35);
  --private-text: oklch(0.15 0.015 30);
  --private-muted: oklch(0.35 0.02 30);
  --private-subtle: oklch(0.50 0.02 30);
  --private-border: oklch(0.65 0.02 30);
  --private-input: oklch(0.82 0.01 35);
  --private-accent: #ff5c8a;
  --private-cta-bg: oklch(0.30 0.025 35);
  --private-cta-text: oklch(0.96 0.008 35);
}

@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --private-bg: oklch(0.23 0.015 285);
    --private-surface: oklch(0.28 0.015 285);
    --private-text: oklch(0.90 0.005 285);
    --private-muted: oklch(0.72 0.01 285);
    --private-subtle: oklch(0.55 0.01 285);
    --private-border: oklch(0.38 0.02 285);
    --private-input: oklch(0.20 0.015 285);
    --private-accent: oklch(0.85 0.08 5);
    --private-cta-bg: oklch(0.70 0.10 295);
    --private-cta-text: oklch(0.23 0.015 285);
  }
}

* { box-sizing: border-box; }

html, body { min-height: 100%; }

body {
  display: flex;
  min-height: 100vh;
  align-items: center;
  justify-content: center;
  margin: 0;
  padding: 1.5rem;
  background: var(--private-bg);
  color: var(--private-text);
  font: 400 0.9rem/1.6 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.private-page { width: min(100%, 32rem); }

.private-shell {
  border: 1px solid var(--private-border);
  background: var(--private-surface);
  padding: clamp(1.5rem, 5vw, 2.25rem);
}

.private-brand {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 2.25rem;
  padding-bottom: 0.85rem;
  border-bottom: 1px solid color-mix(in oklch, var(--private-border) 55%, transparent);
  color: var(--private-text);
  font-size: 0.85rem;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.private-brand strong {
  color: var(--private-text);
  font-size: 0.85rem;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.private-brand span {
  color: var(--private-subtle);
  font-size: 0.7rem;
  font-weight: 400;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.private-kicker {
  margin: 0 0 0.75rem;
  color: var(--private-accent);
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

h1 {
  margin: 0 0 0.75rem;
  color: var(--private-text);
  font-size: clamp(1.35rem, 4vw, 1.7rem);
  line-height: 1.2;
  letter-spacing: -0.04em;
}

p { margin: 0; color: var(--private-muted); }

.private-form { margin-top: 1.75rem; }

label {
  display: block;
  margin-bottom: 0.5rem;
  color: var(--private-text);
  font-size: 0.8rem;
  font-weight: 600;
}

input[type=text] {
  display: block;
  width: 100%;
  margin: 0;
  padding: 0.75rem 0.85rem;
  border: 1px solid var(--private-border);
  border-radius: 0;
  background: var(--private-input);
  color: var(--private-text);
  font: inherit;
}

input[type=text]:focus {
  outline: 2px solid var(--private-accent);
  outline-offset: 2px;
}

input[type=text]::placeholder { color: var(--private-subtle); }

.private-action {
  display: inline-flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  margin-top: 1rem;
  padding: 0.8rem 1rem;
  border: 2px solid var(--private-border);
  border-radius: 0;
  background: var(--private-cta-bg);
  color: var(--private-cta-text);
  font: 600 0.8rem/1.2 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;
  transition: transform 160ms ease-out, background-color 160ms ease-out, color 160ms ease-out, opacity 160ms ease-out;
}

@media (hover: hover) and (pointer: fine) {
  .private-action:hover:not(:disabled) {
    background: var(--private-bg);
    color: var(--private-text);
  }
}

.private-action:active:not(:disabled) { transform: scale(0.97); }

.private-action:focus-visible { outline: 2px solid var(--private-accent); outline-offset: 3px; }

.private-action:disabled { cursor: not-allowed; opacity: 0.5; }

.private-error {
  min-height: 1.5rem;
  margin-top: 0.75rem;
  color: var(--private-accent);
  font-size: 0.75rem;
}

.private-note {
  margin-top: 1.5rem;
  padding-top: 1rem;
  border-top: 1px solid color-mix(in oklch, var(--private-border) 55%, transparent);
  color: var(--private-subtle);
  font-size: 0.75rem;
}

@media (prefers-reduced-motion: reduce) {
  .private-action { transition: opacity 160ms ease-out, background-color 160ms ease-out, color 160ms ease-out; }
}
`
