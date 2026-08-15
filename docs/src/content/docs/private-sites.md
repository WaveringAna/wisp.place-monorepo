---
title: Private Sites
description: Access-controlled static sites stored by wisp.place
---

Private sites are static sites that are only available to their owner and people they are
shared with. Their files and metadata are stored by wisp.place, not in the owner's PDS, and
do not appear in the firehose.

Private sites are access-controlled, not end-to-end encrypted. The wisp.place operator can
read their contents. Use application-layer encryption if the host must not be able to read a
site.

## Uploading

In the web app, open **Upload**, select **Upload privately**, choose a folder, and set an
expiry. The site appears alongside public sites in the **Sites** tab.

With the CLI:

```bash
wispctl private deploy --path ./report --name "report"
```

The default expiry is seven days. Use `--expiry 0` for no expiry, or pass a number of
minutes up to one year:

```bash
wispctl private deploy --path ./report --name "report" --expiry 1440
```

Private sites are limited to 500 files and 100 MB in total. They cannot be updated in
place; upload a new private site and delete the old one when its contents change.

## Opening a site

Each private site has its own `*.priv.wisp.place` address. Opening it requires one of:

- the owner signed in with their AT Protocol account
- an account that has been given access
- an active unrestricted share link

Private sites cannot be mapped to a wisp subdomain or custom domain. Responses are not
cached by the browser or indexed by search engines.

## Sharing

Expand a private site in the **Sites** tab to create and revoke share links. A link can be:

- unrestricted, so anyone holding it can open the site
- restricted to an AT Protocol account, so the recipient must sign in with that account

An account-restricted recipient can later open the private-site address while signed in,
without using the share link again. Revoking the share removes that access.

With the CLI:

```bash
# Anyone with the link can open it
wispctl private share <site-id> --label "review"

# Only this account can open it
wispctl private share <site-id> --to did:plc:...

wispctl private shares <site-id>
wispctl private revoke <site-id> <share-id>
```

A new share link is shown once and cannot be retrieved later. Treat unrestricted links as
credentials. The share list retains its label, status, expiry, last-used time, and a short
non-secret token prefix.

Share links use the same expiry rules as sites. An omitted expiry uses the seven-day
default, `0` means no expiry, and a positive value is a number of minutes. A share can
never outlive its site.

## Expiry and deletion

After a site expires, its links stop working and the site is removed. Deleting a private
site removes its files and all of its share links immediately.

```bash
wispctl private list
wispctl private delete <site-id>
```
