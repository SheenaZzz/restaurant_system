# Build guide -- the roadmap

Alongside: [DESIGN.md](DESIGN.md) (architecture and data model) · [DEPLOYMENT.md](DEPLOYMENT.md) (devices and deployment)

---

## How the work is organised

- **Write the code first, then explain the design, structure it, and accept it.**
- Every step follows the same shape: **goal -> why it is designed this way -> what to build -> what "done" means**
- Once a step is built, run its acceptance command and check the output before moving on
- When stuck, look for a hint rather than an answer -- the value of this project
  is being able to explain every decision in an interview

> ⚠️ **Keep the engineering journal.** From Step 1 onward, `JOURNAL.md` records
> three things: (1) every choice made (what was picked, what was rejected, why),
> (2) the numbers before and after each benchmark, (3) every bug that cost more
> than two hours (symptom / wrong assumption / how it was found / root cause).
> **That journal is all the ammunition a deep dive needs, and it cannot be
> reconstructed afterwards.**

---

## Roadmap

### Weeks 1-2: the skeleton

| Step | Content | Done when |
|---|---|---|
| ~~**0**~~ | ~~Environment and repository~~ ✅ | |
| ~~**1**~~ | ~~Walking skeleton~~ ✅ | Verified on a real iPad (blank over HTTP / working over HTTPS) |
| ~~**2**~~ | ~~Data model~~ ✅ | 17 tables; 20 tables + 19 dishes + 8 prices + 3 accounts seeded |
| ~~**3**~~ | ~~Auth and RBAC~~ ✅ | `front` calling an admin endpoint -> 403 (enforced server-side) |
| ~~**4**~~ | ~~Opening a table~~ ✅ | Floor + open + close, fully offline; **still to be timed at 5 seconds** |
| ~~**5**~~ | ~~Refill logging + kitchen screen~~ ✅ | Three big buttons, ten slots a page; front and kitchen can both log |
| **6** | Wire offline into the real workflow | In airplane mode, open 5 tables and log 10 refills -> all stored on reconnect, no duplicates |

### Week 3: going live

| Step | Content | Done when |
|---|---|---|
| **7** | Deploy on the store's server + domain + Let's Encrypt | One real dinner service, running in shadow |

### Unplanned but done (all of it asked for on the floor)

- Card-style check list, plus four tabs: floor / list / to go / month report
- Edit / void / **reversible void** / transfer / merge
- Payment methods (cash / card / mixed / other) plus a POS keypad
- Large-party service charge (10% at five guests)
- Sales tax rate (in settings, set once, with effective-date history)
- The real 143-item menu, plus to-go (Buffet To Go by weight / phone orders)
- A la carte dishes on a dine-in check; a whole table can skip the buffet
- Month report (calendar of sales + daily tips + reconciliation warnings)
- Full operation history per check (before/after diffs, no extra storage)
- Roles split into front_employee / front_manager / kitchen / admin
- Dead letter queue viewer, and a local data reset

### After that

| Step | Content |
|---|---|
| **6** | Offline hardening + chaos testing (pull the cable, pull the power) + observability <- next |
| **7** | Deploy on the store's server + domain + Let's Encrypt |
| **8** | Close-of-day batch (reconciliation gap) |
| **9** | Exception screen (walkouts / comps) |
| **12** | Remote access for the owner (Cloudflare Tunnel) |
| **13** | Consumption model + restocking suggestions |

---

## Why Step 1 is the one that matters

A **walking skeleton** is one end-to-end loop with **no business logic in it**:

```
a button on the iPad
  -> writes IndexedDB + the outbox
  -> sends over HTTPS to Caddy
  -> FastAPI writes to Postgres idempotently
  -> queues while offline, replays on reconnect
```

Getting that to work proves the architecture holds. Failing to get it to work
means changing the approach **before any business code is written**.

**The biggest risk sits right here**: iPad Safari only registers a Service
Worker over HTTPS, and the store's server is a private LAN address. If that
cannot be solved, offline capability is zero and the whole design falls over.

> Hence: **build the skeleton, then grow the business logic into it.** Never
> write the features first and think about offline afterwards.

---

## Directory layout

```
restaurant_system/
├── DESIGN.md
├── DEPLOYMENT.md
├── GUIDE.md
├── JOURNAL.md          <- engineering journal (kept from Step 1)
├── .gitignore
├── docker-compose.yml
├── backend/
│   ├── requirements.txt
│   ├── alembic.ini
│   ├── alembic/
│   └── app/
│       ├── __init__.py
│       ├── main.py         FastAPI entry point
│       ├── db.py           connection and session
│       ├── core/           config, security, dependency injection
│       ├── models/         SQLAlchemy models
│       └── api/            routes
├── frontend/
│   ├── package.json
│   ├── vite.config.ts
│   └── src/
│       ├── main.tsx
│       ├── db.ts           Dexie (local tables + outbox)
│       ├── sync.ts         syncing and replay
│       └── pages/
└── ops/
    └── Caddyfile
```
