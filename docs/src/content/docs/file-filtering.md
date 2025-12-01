---
title: File Filtering & .wispignore
description: Control which files are uploaded to your Wisp site
---

# File Filtering & .wispignore

Wisp automatically excludes common files that shouldn't be deployed (`.git`, `node_modules`, `.env`, etc.).

## Default Exclusions

- Version control: `.git`, `.github`, `.gitlab`
- Dependencies: `node_modules`, `__pycache__`, `*.pyc`
- Secrets: `.env`, `.env.*`
- OS files: `.DS_Store`, `Thumbs.db`, `._*`
- Cache: `.cache`, `.temp`, `.tmp`
- Dev tools: `.vscode`, `*.swp`, `*~`, `.tangled`
- Virtual envs: `.venv`, `venv`, `env`

## Custom Patterns

Create a `.wispignore` file in your site root using gitignore syntax:

```
# Build outputs
dist/
*.map

# Logs and temp files
*.log
temp/

# Keep one exception
!important.log
```

### Pattern Syntax

- `file.txt` - exact match
- `*.log` - wildcard
- `logs/` - directory
- `src/**/*.test.js` - glob pattern
- `!keep.txt` - exception (don't ignore)

## Usage

**CLI**: Place `.wispignore` in your upload directory
```bash
wisp-cli handle.bsky.social --path ./my-site --site my-site
```

**Web**: Include `.wispignore` when uploading files

## Notes

- Custom patterns add to (not replace) default patterns
- Works in both CLI and web uploads
- The CLI logs which files are skipped
