# wisp.place E2E Harness

Runs the full path with Docker Compose:

1. Compose starts a private reference PDS and local PLC, then seeds `alice.test` and `bob.test`.
2. Main app signs into the seeded Alice account through Playwright OAuth.
3. The harness claims a random `*.wisp.place` domain.
4. The harness uploads a small site through `/wisp/upload-files`.
5. The firehose service receives the `place.wisp.fs` event from the local PDS and writes files to MinIO/S3.
6. The hosting service serves the mapped domain, first from cold/S3, then from hot memory.
7. The harness deletes the claimed domain and verifies hosting stops serving the cached domain route.
8. The harness deletes the site record and verifies firehose plus hosting cache invalidation stops direct site serving.

Run:

```sh
bun run e2e:harness
```

Tear down volumes:

```sh
bun run e2e:harness:down
```

Useful overrides:

```sh
E2E_ATPROTO_HANDLE='another.test'
E2E_ATPROTO_PASSWORD='...'
E2E_CLEANUP=false
E2E_HEADLESS=false
E2E_TIMEOUT_MS=300000
E2E_DOMAIN_HANDLE=e2e-my-run
E2E_SITE_RKEY=e2e-my-run
```
