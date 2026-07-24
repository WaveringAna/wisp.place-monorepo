# private sites v1 - verification artifacts

Captured against real running services (postgres + minio + hosting-service + the real
XRPC handlers), not mocks.

| file | shows |
|---|---|
| `01-anonymous-denied.png` | anonymous visitor gets a bare 404 |
| `02-valid-share-link-works.png` | a valid share link renders the private site |
| `03-revoked-share-denied.png` | **byte-identical** to 01 after revocation |
| `04-nested-page-via-share.png` | share credential works on nested paths |
| `05-cli-uploaded-site.png` | site uploaded via `wisp private deploy`, served back |
| `private-sites-walkthrough.mp4` | 25s, 6 steps, includes a live revocation |
| `response-headers.txt` | no-store / no-referrer / noindex vs a public site |

Denial screenshots 01 and 03 share sha256
`ca62fbef83c6b83a9e1d0a594bdfb2b5609cd79a26f6a4473c8f3b78fc292a09`, which is the point:
a holder of a revoked link cannot distinguish it from a site that never existed.
