// ./config evaluates the service configuration on first import, and that needs a
// database URL unless local development is explicit. bun test already sets
// NODE_ENV=test; unit tests opt into the insecure development mode so they load
// without a real environment. Import this before anything that loads ./config.
process.env.WEBHOOK_ALLOW_INSECURE_DEV ??= '1'
