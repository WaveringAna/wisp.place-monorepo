---
title: File Filtering & .wispignore
description: Control which files are uploaded to your Wisp site
---

Wisp automatically excludes common files that shouldn't be deployed — version control (`.git`, `.github`), dependencies (`node_modules`, `__pycache__`), secrets (`.env`, `.env.*`), OS files (`.DS_Store`, `Thumbs.db`), caches, and dev tooling.

To exclude additional files, create a `.wispignore` in your site root using gitignore syntax:

```
# Build artifacts
dist/
*.map

# Logs
*.log
temp/

# Keep a specific file
!important.log
```

Custom patterns are added on top of the defaults, not in place of them. The CLI logs which files are skipped.
