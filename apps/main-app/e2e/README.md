# wisp.place E2E Harness

Runs the full path with Docker Compose:

1. Main app signs into a real ATProto test account through Playwright OAuth.
2. The harness claims a random `*.wisp.place` domain.
3. The harness uploads a small site through `/wisp/upload-files`.
4. The firehose service receives the `place.wisp.fs` event and writes files to MinIO/S3.
5. The hosting service serves the mapped domain, first from cold/S3, then from hot memory.
6. The harness deletes the claimed domain and verifies hosting stops serving the cached domain route.
7. The harness deletes the site record and verifies firehose plus hosting cache invalidation stops direct site serving.

Required environment:

```sh
export E2E_ATPROTO_HANDLE='test.example.com'
export E2E_ATPROTO_PASSWORD='...'
```

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
E2E_CLEANUP=false
E2E_HEADLESS=false
E2E_TIMEOUT_MS=300000
E2E_DOMAIN_HANDLE=e2e-my-run
E2E_SITE_RKEY=e2e-my-run
```
