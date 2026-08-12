# Hardware list and how it all connects

Alongside: [DESIGN.md](DESIGN.md)

---

## 1. Network topology

```
   owner at home (admin)                     Internet (ISP)
        │                                        │
        │  https://admin.your-domain.com         │
        ▼                                        │
  ┌───────────────┐                     ┌────────┴────────┐
  │ Cloudflare    │◀── outbound only ─┐ │  router (WiFi 6) │
  │ Access+Tunnel │  (no inbound port) │ │ DHCP reserve .10 │
  └───────────────┘                    │ └────────┬────────┘
                                       │     ┌────┴────┬──────────┐
                                       │ wired    WiFi │     WiFi │
                                       │     │         │          │
                        ┌──────────────┴─────┴┐  ┌─────┴──┐ ┌─────┴──┐
                        │  store server        │  │front   │ │kitchen │
                        │  192.168.1.10        │  │ iPad   │ │ iPad   │
                        │  Ubuntu Server       │  └────────┘ └────────┘
                        │ ┌──────────────────┐ │
                        │ │ Docker Compose   │ │
                        │ │ ├ Caddy (LAN TLS)│ │  <- :443 in store
                        │ │ ├ FastAPI  :8000 │ │  <- staff API (LAN only)
                        │ │ ├ FastAPI  :8001 │ │  <- admin API (tunnel only)
                        │ │ ├ cloudflared    │ │
                        │ │ ├ Postgres       │ │
                        │ │ └ cron (backup)  │ │
                        │ └──────────────────┘ │
                        │         │            │
                        │      [UPS]           │
                        └─────────┼────────────┘
                                  │ nightly encrypted backup
                                  ▼   object storage (B2 / S3)
```

**Two paths, with completely separate security boundaries:**

| Path | Users | Route | When the internet is down |
|---|---|---|---|
| **Staff path** (critical) | front / kitchen | LAN -> Caddy -> :8000 | **keeps working** |
| **Owner path** (not critical) | admin | internet -> Cloudflare Access -> tunnel -> :8001 | unavailable (acceptable) |

> **The core argument: the critical path stays on the LAN, the non-critical path
> goes through the tunnel.** The staff sync API is **never exposed to the public
> internet**; the owner losing a report does not stop the business running.

---

## 2. Hardware

### 2.1 Store server (the core, one unit)

**Recommended**: an x86 mini PC (N100 class), 16 GB RAM, 500 GB NVMe SSD, Ubuntu Server LTS

| Option | Price | Assessment |
|---|---|---|
| **N100 mini PC** | ~$200 | ✅ Recommended. Reliable SSD, x86 avoids ARM package problems, silent, ~10 W, fine 24/7 |
| Mac mini (M-series) | ~$599 | Works but costs more; macOS auto-update and reboots are a nuisance on a headless box |
| Raspberry Pi 5 8GB | ~$140 (with SSD) | Cheapest. **Must run off a USB3 SSD, never an SD card** (they corrupt); little headroom for analysis batches |

**Required settings**:
- Enable **"Power On After AC Loss"** in the BIOS -- it comes back up by itself after an outage
- Static IP (as a DHCP reservation on the router, not hard-coded on the host)
- **Wired to the router**, not on WiFi

### 2.2 UPS (one, do not skip it)

600 VA class, ~$70.

Restaurant power is unstable and breakers trip. **An unclean shutdown corrupts
Postgres data files.** A UPS buys 15-30 minutes and can tell the host over USB
to shut down gracefully (`nut` or `apcupsd`).

### 2.3 iPads (two)

| Location | Usual account | What it does |
|---|---|---|
| Front | `front` | Floor overview, opening tables (guests/drinks), ordering, pickup, exceptions, close of day |
| Kitchen | `kitchen` | Order queue + **refill logging** |

> **Devices are not tied to identities.** Any device can open the URL, sign in,
> and the interface renders by role. If the front iPad breaks, grab a spare
> tablet, sign in, and keep working -- which is the core benefit of accounts over
> device binding, and it directly reduces the impact of a hardware failure.

The owner needs no dedicated device -- their own phone or laptop and a browser.

**Model**: no need for a new one. A used 9th or 10th generation iPad (~$150-250) is plenty.
⚠️ **It has to run iOS 16.4 or later** -- earlier versions have incomplete PWA / Service Worker support.

**Accessories**:
- Two drop- and grease-resistant cases (it is a restaurant)
- Two desk or VESA mounts -- against drops and against walking off
- Two long charging cables (both units stay in place, permanently plugged in)

> ⚠️ **Think hard about where the kitchen one goes**: smoke, steam and heat
> shorten a device's life noticeably. **Put it at the pass rather than beside the
> range**, in a grease-resistant case, with type large enough to read from a metre away.

### 2.4 Network gear

- Test the store's existing router **before deciding to replace it**: walk a phone to the front, the buffet, the kitchen and the four corners of the dining room, checking signal and latency at each
- If coverage falls short: one WiFi 6 router (~$100), or add a mesh node
- **The server needs a static IP** (a DHCP reservation on the router) -- otherwise a reboot changes it and nothing in the store can connect

### 2.5 Printer (optional, later)

A network thermal receipt printer speaking ESC/POS over TCP (an Epson TM-T20III with Ethernet, ~$250).

> ⚠️ **A PWA on an iPad cannot touch USB or Bluetooth.**
> So printing has to be driven **by the server** -- the iPad sends a command and
> the server talks to the printer. That is cleaner anyway: printing logic lives
> in one place, and any iPad dropping off does not stop tickets.
> The front end has been designed that way from the start, so adding a printer
> later changes nothing.

### 2.6 Backup target

- Cloud object storage (Backblaze B2 / AWS S3), ~$2/month
- Optionally a USB drive on the server as a second local copy

---

## 3. The HTTPS certificate chain (the one part that could force a redesign)

### 3.1 The problem

iPad Safari only runs a **Service Worker over HTTPS** (`localhost` excepted).
No Service Worker means **no offline capability**, which means the architecture collapses.

And the server sits on a private LAN address (192.168.1.10), for which **no public CA will issue a certificate**.

### 3.2 The solution: a domain + DNS-01 challenge + DNS pointing at the LAN address

```
1. Buy a domain (~$12/year) and host its DNS at Cloudflare
2. Add one A record: pos.your-domain.com  ->  192.168.1.10
   (pointing public DNS at a private address is entirely legal; anyone outside
    resolves a private address and cannot connect -- which is exactly the
    isolation we want)
3. Caddy requests a certificate from Let's Encrypt via a DNS-01 challenge
   (DNS-01 needs no inbound access, only the ability to edit a DNS record,
    i.e. a Cloudflare API token)
4. On the store WiFi an iPad resolves pos.your-domain.com -> 192.168.1.10
   -> connects to the server -> the certificate is a real Let's Encrypt one
   -> the Service Worker works
5. Caddy renews automatically (about every 60 days), with nobody involved
```

**The big win: no self-signed root certificate on any iPad.** Zero configuration
when swapping devices, and nothing for staff to do.

The `Caddyfile` looks roughly like:

```
pos.your-domain.com {
    tls {
        dns cloudflare {env.CLOUDFLARE_API_TOKEN}
    }
    reverse_proxy app:8000
}
```

### 3.3 The alternative (not recommended)

Generate a local CA with `mkcert` and install and trust the root certificate on every iPad.

The downsides: every device needs it installed by hand, and on iOS it also needs
a second switch under Settings > General > About > Certificate Trust Settings;
a new device means doing it again; an expired certificate means doing all of them again.

---

## 4. iPad setup (once per device, about two minutes)

```
1. Open https://pos.your-domain.com in Safari
2. Share button -> "Add to Home Screen"
3. An icon appears; from then on it opens full screen with no address bar
4. Settings > Display & Brightness > Auto-Lock > Never (these are fixed installations)
5. Settings > Accessibility > Guided Access > on
   -> triple-click the power button inside the app to lock it there, so nobody exits by accident
```

### Three iOS traps

1. **A home screen app and Safari have isolated storage.**
   If someone uses it in Safari first and then adds it to the home screen, the
   earlier local data **does not come with it**.
   -> The order has to be: **install to the home screen first, then start using it**.

2. **iOS has no Background Sync.**
   The offline queue can only replay while the app is in the foreground.
   -> Every launch triggers a full replay immediately, and the UI shows "N pending".

3. **iOS evicts website data when storage runs short.**
   -> Local storage can never be the only copy; sync has to be as prompt as
   possible to keep the outbox short.

---

## 5. Data flow

```
1. an action on the iPad
     -> writes IndexedDB (the UI responds immediately)
     -> appends to the outbox (with an op_id UUID as the idempotency key)

2. online -> POST /sync -> FastAPI -> Postgres (ON CONFLICT DO NOTHING)

3. the server broadcasts the change -> WebSocket -> other iPads update live

4. offline -> local reads and writes continue, the outbox grows, the UI shows the pending count

5. reconnect -> the outbox replays in batches, deduplicated by op_id -> confirmed entries are dropped

6. nightly cron -> pg_dump -> encrypt -> upload to object storage
                 -> run the analysis batch (consumption rate / restocking)
```

---

## 6. Remote access for the owner

The owner has to sign in from home **on their own phone or laptop with nothing
installed** -- which rules out a VPN.

### The options

| Approach | What the owner has to do | Verdict |
|---|---|---|
| **Cloudflare Tunnel + Access** | Open a URL and sign in | ✅ Chosen |
| Tailscale VPN | Install an app, stay signed in, join the tailnet | Continuous friction for a non-technical user |
| Port forwarding on the router | Nothing | ✗ Exposes the LAN to every scanner on the internet |
| Move everything to the cloud | Nothing | ✗ An outage stops the whole store |

### The chain

```
owner's phone
  -> https://admin.your-domain.com
  -> Cloudflare Access (email OTP / Google sign-in, 50 users on the free tier)
  -> Cloudflare edge
  -> the tunnel (an outbound connection opened by cloudflared in the store)
  -> FastAPI :8001 on the LAN (admin routes only)
  -> the application checks username, password and role=admin again
```

**Two things that matter:**

1. **No inbound port is opened on the router.** `cloudflared` dials **out** from
   the store. There is no inbound entry point on the internet pointing at this shop.
2. **The staff sync API (:8000) never goes through the tunnel.** The tunnel maps
   admin routes (:8001) only. Even if Cloudflare's side were compromised, the
   staff write path is not part of the exposed surface.

> This is section 1's "critical path on the LAN, non-critical path through the
> tunnel" in practice. The owner losing a report does not stop the business, so
> that path can afford to depend on the internet.

---

## 7. Failure modes and recovery

| Failure | Impact | Response |
|---|---|---|
| Internet down (ISP outage) | **None**; the business runs on the LAN | Certificates last 90 days, so a delayed renewal is fine |
| WiFi down | iPads go offline and store locally | The outbox replays automatically on reconnect |
| Server loses power | Every iPad runs offline | The UPS holds it up -> graceful shutdown; the BIOS powers it back on |
| Postgres container crashes | Briefly unwritable | `restart: always` plus a healthcheck bring it back |
| Server disk fails | Restore needed | Restore from the nightly backup; the iPads still hold recent data |
| iPad dropped or lost | Only that device's **unsynced** work is lost | Which is why sync is prompt and the UI shows the pending count |
| Staff deletes something | Recoverable | `sync_op` keeps everything and can be replayed |

**Chaos test checklist** (weeks 6-7, and the core material for a deep dive):
- [ ] Pull the network cable for 10 minutes at peak, keep taking orders and logging refills, verify nothing is lost on reconnect
- [ ] Pull the server's power outright, verify data integrity after the reboot
- [ ] Edit the same check from two iPads at once, verify the conflict policy
- [ ] Perform 50 operations on an iPad in airplane mode, verify all of them land with no duplicates
- [ ] Replay the same batch of ops twice, verify idempotency

---

## 8. Cost

| Item | Price |
|---|---|
| N100 mini PC, 16G/500G | ~$200 |
| UPS 600VA | ~$70 |
| 2 iPads (used 9th/10th gen) | ~$300-400 |
| 2 mounts + 2 cases | ~$80 |
| WiFi 6 router (**test first, it may not be needed**) | ~$100 |
| Domain | ~$12/year |
| Cloudflare Tunnel + Access | **$0** (the free tier is enough) |
| Cloud backup | ~$2/month |
| Network receipt printer (optional, later) | ~$250 |

**Starting cost (no printer, keeping the router): about $660**

> 💡 **Do not buy any of it up front.**
> Use an old laptop as the server and one iPad you already own, get the week-2
> HTTPS + PWA + offline write chain working, confirm the approach holds and that
> the family will actually use it -- and only then spend the money.
