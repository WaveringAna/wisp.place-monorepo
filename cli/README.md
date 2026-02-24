# wispctl CLI

Run from the `cli/` directory:

```bash
bun run index.ts --help
```

Deploying a site
```bash
bun run index.ts deploy alice.bsky.social --path . --site my-blog
bun run index.ts alice.bsky.social --path . --site my-blog
```

List domains for an account:

```bash
bun run index.ts list domains alice.bsky.social
```

List sites for an account:

```bash
bun run index.ts list sites alice.bsky.social
```

Use an alternate proxy service DID:

```bash
bun run index.ts list domains alice.bsky.social --service did:web:regents-macbook-air.west-major.ts.net
```

Domain CRUD examples:

```bash
bun run index.ts domain claim alice.bsky.social --domain example.com
bun run index.ts domain claim-subdomain alice.bsky.social --subdomain alice
bun run index.ts domain status alice.bsky.social --domain example.com
bun run index.ts domain add-site alice.bsky.social --domain example.com --site mysite
bun run index.ts domain delete alice.bsky.social --domain example.com
bun run index.ts site delete alice.bsky.social --site mysite
```

OAuth note:
- CLI requests `rpc:<nsid>?aud=*` scopes for Wisp XRPC methods.
- `--service did:...` controls proxy target (`atproto-proxy`), not scope audience (scoping audience couldnt work for me idk why).
