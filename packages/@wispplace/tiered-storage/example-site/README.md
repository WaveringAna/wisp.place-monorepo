# Example Static Site

This is a demonstration static website used in the tiered-storage library examples.

## Files

- **index.html** (3.5 KB) - Homepage, stored in hot + warm + cold tiers
- **about.html** (4.2 KB) - About page, stored in warm + cold (skips hot)
- **docs.html** (3.8 KB) - Documentation, stored in warm + cold (skips hot)
- **style.css** (7.1 KB) - Stylesheet, stored in warm + cold (skips hot)
- **script.js** (1.9 KB) - JavaScript, stored in warm + cold (skips hot)

## Usage in Examples

The `example.ts` file demonstrates how this site would be stored using the tiered-storage library:

1. **index.html** is stored in all tiers (hot + warm + cold) because it's the entry point and needs instant serving
2. Other HTML pages skip the hot tier to save memory
3. CSS and JS files are stored in warm + cold
4. If there were large media files, they would be stored in cold tier only

## Tier Strategy

```
Hot Tier (Memory - 100MB):
  └── index.html (3.5 KB)

Warm Tier (Disk - 10GB):
  ├── index.html (3.5 KB)
  ├── about.html (4.2 KB)
  ├── docs.html (3.8 KB)
  ├── style.css (7.1 KB)
  └── script.js (1.9 KB)

Cold Tier (S3 - Unlimited):
  ├── index.html (3.5 KB)
  ├── about.html (4.2 KB)
  ├── docs.html (3.8 KB)
  ├── style.css (7.1 KB)
  └── script.js (1.9 KB)
```

This strategy ensures:
- Lightning-fast serving of the homepage (from memory)
- Efficient use of hot tier capacity
- All files are cached on disk for fast local access
- S3 acts as the source of truth for disaster recovery
