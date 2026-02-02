# wisp.css

A minimal, monospace-first CSS stylesheet with automatic light/dark mode. See it live on https://wisp.place or https://sites.wisp.place/wisp.place/wisp.css for a demo.

## Quick Start

### CDN
```html
<link rel="stylesheet" href="https://sites.wisp.place/wisp.place/wisp.css/wisp.css">
```

### Self-hosted

Just copy `wisp.css` to your project and link to it:

```html
<link rel="stylesheet" href="/wisp.css">
```

## Features

- **Automatic dark mode** via `prefers-color-scheme`
- **CSS custom properties** for easy theming
- **JetBrains Mono** typography
- **Components**: cards, buttons, alerts, forms
- **Utility classes**: spacing, flexbox, text styling
- **Responsive** with mobile-first breakpoints

## CSS Variables

All variables use the `--wisp-` prefix. Unprefixed aliases are also available for convenience.

### Colors

```css
--wisp-bg           /* Main background */
--wisp-bg-alt       /* Alternate background (cards, etc) */
--wisp-text         /* Primary text */
--wisp-text-muted   /* Secondary text */
--wisp-text-subtle  /* Tertiary text */
--wisp-border       /* Strong borders */
--wisp-border-light /* Light borders */
--wisp-accent       /* Accent/link color */
--wisp-cta-bg       /* Button background */
--wisp-cta-text     /* Button text */
--wisp-code-bg      /* Code block background */
--wisp-success      /* Success state */
--wisp-danger       /* Error/danger state */
--wisp-warning      /* Warning state */
--wisp-info         /* Info state */
```

### Customizing

Override variables in your own CSS:

```css
:root {
    --wisp-accent: oklch(0.65 0.20 200); /* Blue accent */
}
```

## Components

### Cards

```html
<div class="card">Basic card</div>
<div class="card success">Success card</div>
<div class="card danger">Danger card</div>
<div class="card info">Info card</div>
```

### Buttons

```html
<button>Primary button</button>
<button class="outline">Outline button</button>
<a class="cta-primary" href="#">CTA Primary</a>
<a class="cta-secondary" href="#">CTA Secondary</a>
```

### Alerts

```html
<div class="alert alert-success">Success message</div>
<div class="alert alert-danger">Error message</div>
<div class="alert alert-warning">Warning message</div>
<div class="alert alert-info">Info message</div>
```

### Forms

```html
<label for="email">Email</label>
<input type="email" id="email" placeholder="you@example.com">
```

## Utility Classes

### Spacing

- `.m-{0-4}` - margin
- `.mt-{0-6}`, `.mb-{0-6}`, `.ml-{0-4}`, `.mr-{0-4}` - directional margin
- `.p-{0-6}` - padding
- `.px-{1-4}`, `.py-{1-4}` - horizontal/vertical padding
- `.gap-{1-6}` - flex/grid gap

### Flexbox

- `.flex`, `.inline-flex`
- `.flex-col`, `.flex-wrap`
- `.items-start`, `.items-center`, `.items-end`
- `.justify-start`, `.justify-center`, `.justify-end`, `.justify-between`

### Text

- `.text-left`, `.text-center`, `.text-right`
- `.text-sm`, `.text-base`, `.text-lg`, `.text-xl`
- `.font-normal`, `.font-medium`, `.font-semibold`, `.font-bold`
- `.text-muted`, `.text-subtle`, `.text-accent`, `.text-success`, `.text-danger`

### Display

- `.hidden`, `.block`, `.inline`, `.inline-block`, `.flex`, `.grid`
- `.hide-mobile` - hidden on screens < 768px
- `.hide-desktop` - hidden on screens >= 769px

## Layout

```html
<div class="container">
    <!-- max-width: 900px, centered with padding -->
</div>

<div class="container-wide">
    <!-- max-width: 1100px, centered with padding -->
</div>
```

## License

MIT
