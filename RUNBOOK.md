# Runbook

## First-time setup

```bash
cp .env.example .env          # change POSTGRES_PASSWORD
cd frontend && npm install && cd ..
```

## Day-to-day development (two terminals)

```bash
# terminal 1: database + backend
docker compose up -d --build
docker compose logs -f api

# terminal 2: front end
cd frontend && npm run dev
```

- Front end http://localhost:5173
- Backend http://localhost:8000 · docs http://localhost:8000/docs
- The front end only calls `/api/*`, proxied to the backend by Vite -> **development and production use identical request paths**

## Everyday commands

```bash
docker compose ps                       # status
docker compose logs -f api              # backend logs
docker compose restart api              # restart the backend
docker compose exec db psql -U restaurant -d restaurant   # open the database
```

## Database migrations (Alembic)

`backend/app/models.py` is the single source of truth for the schema. After changing a model:

```bash
docker compose run --rm --no-deps -v "$PWD/backend/alembic/versions:/app/alembic/versions" -e DATABASE_URL="postgresql+psycopg://restaurant:change_me_local_dev@db:5432/restaurant" api alembic revision --autogenerate -m "description"
```

⚠️ **Two traps you will hit otherwise**:

1. **The `versions` directory has to be mounted**, or the generated migration
   stays inside the container and `--rm` deletes it
2. **After generating, `docker compose build api` and restart** -- migrations are
   `COPY`'d into the image, so an old image has no new migration and
   `alembic upgrade head` **silently does nothing** (the giveaway is no
   `Running upgrade` line in the log)

Applying migrations: `entrypoint.sh` runs `alembic upgrade head` on container start, so there is nothing to do by hand.

```bash
docker compose build api && docker compose up -d api
docker compose exec api python -m app.seed      # seed data, idempotent
docker compose exec api alembic current         # current revision
docker compose exec api alembic history         # migration history
```

**Rebuilding the database from scratch**:

```bash
docker compose down -v && docker compose up -d --build
```

> ⚠️ `-v` deletes every **named volume**, database data included. **Never** run
> it against production once Step 7 is live.
>
> The local CA moved to a bind mount at `ops/caddy-data/` and is **unaffected by
> `-v`** -- so the root certificate installed on an iPad keeps working and does
> not have to be reinstalled. That directory holds the CA's **private key**; it
> is gitignored and must never be committed.

## Acceptance tests (Step 1)

```bash
# 1. health check
curl -s localhost:8000/api/health

# 2. idempotency: send the same batch twice; the second is all duplicates and the count does not move
BODY='{"client_id":"t1","since_cursor":0,"ops":[{"op_id":"11111111-1111-4111-8111-111111111111","entity":"ping_event","op_type":"insert","client_seq":1,"client_ts":"2026-01-01T00:00:00Z","payload":{"label":"A"}}]}'
curl -s -X POST localhost:8000/api/sync -H 'Content-Type: application/json' -d "$BODY"
curl -s -X POST localhost:8000/api/sync -H 'Content-Type: application/json' -d "$BODY"
curl -s localhost:8000/api/debug/count

# 3. offline replay: stop the API -> tap N times in the page -> start the API -> tap "sync now"
docker compose stop api
docker compose start api
```

Check in the browser: `pending` reaches zero, and `debug/count` grew by exactly N with no duplicates.

## Testing on a real iPad

### On the computer (one command)

```bash
cd frontend && npm run build && cd .. && docker compose --profile lan up -d
```

Two entry points once it is up:

| Entry point | Purpose |
|---|---|
| `https://restaurant.local` | The real site; the Service Worker registers |
| `http://restaurant.local:8080` | **The control**, plaintext, where it cannot |

> ⚠️ **Use the hostname, not the IP.** Over HTTPS to an IP the client sends no
> SNI (RFC 6066 allows only a hostname), Caddy matches no site and refuses the
> handshake. `restaurant.local` goes over mDNS, which iOS supports natively, and
> it survives a DHCP address change.
>
> ⚠️ **mDNS answers for the machine's own hostname**, so the host has to be named
> `restaurant` for `restaurant.local` to resolve. How to rename it:
>
> | System | How |
> |---|---|
> | Windows | Settings > System > About > Rename this PC > **reboot** |
> | Linux (the store's server) | `sudo hostnamectl set-hostname restaurant` (avahi advertises it) |
>
> Confirm with `hostname`. A different machine name means updating the two places in `ops/Caddyfile`.

### On the iPad

**1. Install the root certificate** (once)

Open `http://restaurant.local:8080/root.crt` in Safari -> "Profile Downloaded"

- Settings > General > VPN & Device Management > Install
- **⚠️ Then Settings > General > About > Certificate Trust Settings > turn the switch on**
  (the step everyone misses; without it the certificate is not trusted and the SW still will not register)

**2. The control experiment -- this is the point**

| Step | HTTP (`:8080`) | HTTPS |
|---|---|---|
| 1. Open in Safari, Share > Add to Home Screen | ✅ | ✅ |
| 2. Launch from the home screen icon, tap "record" a few times | ✅ | ✅ |
| 3. **Quit the app completely** (swipe up) | | |
| 4. Turn on airplane mode | | |
| 5. Tap the home screen icon again | ❌ **blank page** | ✅ **opens normally** |
| 6. Keep tapping "record" | cannot get in | ✅ queued, shows "pending N" |
| 7. Turn airplane mode off -> automatic replay | | ✅ back to zero |

> ⚠️ Test the two sites from **separate home screen icons**: on iOS a home
> screen app and Safari have isolated storage, and different origins share nothing.

**3. Check the data**

```bash
curl -s localhost:8000/api/debug/count
```

All three numbers should be equal, and equal to the total number of taps (including the earlier 16).

> Once a domain is bought, switch to the production block in the Caddyfile
> (Let's Encrypt DNS-01) and the iPad needs no certificate at all.

## Accounts (development)

| Account | Display name | Role (the key in code) | Password | PIN |
|---|---|---|---|---|
| `manager` | Front manager | `front_manager` | `manager-dev-pw` | 1111 |
| `front` | Front staff | `front_employee` | `front-dev-pw` | 3333 |
| `kitchen` | Kitchen | `kitchen` | `kitchen-dev-pw` | 2222 |
| `boss` | Owner | `admin` | `boss-dev-pw` | -- |

> A username and a role are different things: the username is what someone types
> to sign in, the role is the key the permission checks read. Which is why
> `boss` still has the role `admin`.

⚠️ Before going live these have to become one strong password per person, and
`JWT_SECRET` in `.env` has to be a random value:

```bash
python -c "import secrets;print(secrets.token_urlsafe(48))"
```

Session length differs by role: 30 days for staff (retyping a password at peak
is not going to happen) and 12 hours for admin, whose entry point is exposed to
the public internet.

## Acceptance tests (Step 3, auth)

```bash
# unauthenticated sync -> 401
curl -s -o /dev/null -w "%{http_code}
" -X POST localhost:8000/api/sync -H 'Content-Type: application/json' -d '{"client_id":"x","since_cursor":0,"ops":[]}'

# front signs in and calls an admin endpoint -> 403
FT=$(curl -s -X POST localhost:8000/api/auth/login -H 'Content-Type: application/json' -d '{"username":"front","password":"front-dev-pw","client_id":"t"}' | python -c "import sys,json;print(json.load(sys.stdin)['access_token'])")
curl -s -o /dev/null -w "%{http_code}
" localhost:8000/api/admin/summary -H "Authorization: Bearer $FT"
```

## Debug hooks

`window.__rs` is available in the browser console (on an iPad, attach Safari's Web Inspector):

```js
await __rs.login('front', 'front-dev-pw')
await __rs.refreshCatalog()
await __rs.openTable('A7', {adult:2, child:1, senior:0}, 3)
await __rs.openChecksByTable()
await __rs.sync()
await __rs.db.outbox.count()
await __rs.db.deadletter.toArray()
__rs.build                      // which build this device actually has
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `docker: command not found` | Docker Desktop installs per user; **open a new terminal** so PATH applies |
| API will not start, logs say it cannot reach db | Normal retrying; `depends_on: service_healthy` waits for the healthcheck |
| Model changed but the schema did not | After generating a migration you have to `docker compose build api` -- migrations are COPY'd into the image |
| Several identically named Caddy certificates on the iPad | They are all `Caddy Local Authority - 2026 ECC Root` and indistinguishable. **Delete them all and install one**; the old CA private keys are gone anyway |
| Service Worker will not register on the iPad | HTTPS is required, and the root certificate needs the extra switch under Certificate Trust Settings |
| Data disappears after adding to the home screen | A home screen app and Safari have **isolated storage** -> install first, then use it |
| Code changed but the page is still the old one | Check the build stamp in the header. `localhost` counts as a secure context, so **plaintext 8080 registers a SW too** -> run `(await navigator.serviceWorker.getRegistrations()).forEach(r=>r.unregister())` in the console and reload |
