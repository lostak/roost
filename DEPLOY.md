# Deploying the hosted edition (`server` branch)

The hosted server is a plain Node process. It must run **behind an HTTPS reverse
proxy** in production — never exposed directly on the public internet over http.

## Environment variables

| Variable | Purpose | Example |
|---|---|---|
| `PORT` | Port the Node server listens on (proxy forwards to this). | `5000` |
| `ROOST_DATA` | Directory for the SQLite DB and uploaded PDFs. Put it on encrypted, backed-up storage. | `/var/lib/roost` |
| `ROOST_SECURE` | Set to `1` in production so the session cookie gets the `Secure` flag (HTTPS-only). | `1` |
| `NODE_ENV` | `production` also enables Secure cookies. | `production` |

Run:

```bash
ROOST_SECURE=1 ROOST_DATA=/var/lib/roost PORT=5000 node server.js
```

Keep it alive with a process manager (systemd unit or pm2) and restart on failure.

## TLS termination

Terminate HTTPS at the proxy and forward to the Node port. **Caddy** does certs
automatically:

```
roost.example.com {
    reverse_proxy 127.0.0.1:5000
}
```

**nginx** equivalent (certs via certbot):

```nginx
server {
    listen 443 ssl;
    server_name roost.example.com;
    ssl_certificate     /etc/letsencrypt/live/roost.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/roost.example.com/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_set_header X-Forwarded-For $remote_addr;   # login rate-limiter uses this
        proxy_set_header Host $host;
    }
}
```

The login throttle keys off `X-Forwarded-For`, so make sure the proxy sets it.

## Accounts

Accounts are admin-provisioned from the CLI (self-serve signup is on the roadmap):

```bash
node admin-cli.js add <username>            # prints a generated password once
node admin-cli.js add <username> --admin    # admin account
node admin-cli.js passwd <username>         # reset password
node admin-cli.js list
node admin-cli.js rm <username>             # deletes the account AND its data
```

## Backups

Back up the entire `ROOST_DATA` directory (SQLite DB + `users/<id>/` PDFs) on a
schedule, and **test a restore**. With SQLite/WAL, prefer the `.backup` command or
snapshot the volume while the app is briefly quiesced.

## Before opening to real customers

See `ROADMAP.md` Tier 1 — encryption at rest, email-based account lifecycle,
legal docs (privacy policy / ToS / DPA), and account deletion/export still need to
land first.
