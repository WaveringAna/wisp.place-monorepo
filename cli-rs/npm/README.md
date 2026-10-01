# wispctl

Deploy static sites to [wisp.place](https://wisp.place), where they live as records in your own
AT Protocol repository.

```bash
npm install -g wispctl
wispctl deploy your-handle.bsky.social --path ./dist --site my-site
```

or without installing: `npx wispctl deploy ...`

This package runs a native binary: npm installs only the one for your platform
(macOS arm64/x64, Linux x64/arm64, Windows x64), and nothing is downloaded at install time.

In CI, pass `WISPCTL_APP_PASSWORD` (an app password) with your handle to deploy without a browser.

Full documentation: https://docs.wisp.place/cli/
