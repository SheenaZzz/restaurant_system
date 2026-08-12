# Restaurant Operations

An offline-first operations system for a Chinese buffet restaurant.

It is not a demo. It is the family restaurant's **only record of what happened
today**: there is no POS, the books were kept on paper, and the card terminal is
the only other machine in the building. That single fact sets every constraint in
this repository -- if the system loses data, the day's takings are gone, and if
opening a table takes longer than five seconds at peak, the staff go back to
paper and the system is dead.

**Deliberately not built**: taking payment. The system computes what is owed;
money is still taken on the existing terminal. That keeps PCI out of scope
entirely -- and turns the close-of-day gap between "what the system says is owed"
and "what is in the drawer" into the system's own correctness test.

```
 22 tables · 13 migrations · 143 real menu items · ~14k lines of application code
 Backend  FastAPI + PostgreSQL 16 + SQLAlchemy 2 + Alembic
 Frontend React + TypeScript + Vite + Dexie (IndexedDB), installed as a PWA
 Infra    Docker Compose + Caddy (TLS), one box in the store, nightly backups
```

---

## How this was built

Solo, with a coding agent as the implementation partner -- vibe coding, applied
to something that has to survive contact with a real restaurant rather than a
demo. That distinction is the whole point, so it is worth being precise about
what the work actually consisted of.

**The hard parts of this project were never the typing.** They were: choosing an
idempotency key that survives replay instead of a check-then-insert race;
noticing that an append-only log physically cannot express a deletion, and
working out a detection rule that a bigserial sequence does not defeat; deciding
that guest counts replace while collected money accumulates, and being able to
say why the two are different; designing a collection screen around
interval-censored data because the quantity it measures cannot be observed
directly. Every one of those is a decision with a rejected alternative and a
consequence, and every one of them is written down in [JOURNAL.md](JOURNAL.md)
with the numbers that settled it. They are all open to being probed.

**The debugging is mine too**, and the journal keeps the wrong turns in. The
worst bug in this repository was syncing that stopped completely and silently.
My first hypothesis -- an IndexedDB index quietly excluding records -- was
plausible, and wrong; lining the timeline up against the proxy logs disproved it,
because the requests it blamed happened *before* the first stuck record existed.
The real cause was that `fetch` has no default timeout, so a request in flight
when airplane mode came on never settled, wedged the in-flight guard forever, and
the client never issued another request. The fix is two layers (an
`AbortController` and a watchdog), and the lesson -- a network call without a
timeout is a latent deadlock, and silent stopping is worse than crashing -- is
the kind of thing this codebase is full of.

**What the agent gave me** was speed: turning a settled decision into working
code fast enough to try three approaches in the time one used to take, and
holding a 14k-line codebase in view while doing it. What it did not give me was
correctness. An agent produces *plausible* code, and plausible code fails in ways
only a measurement catches. Three from this repository:

- A tax calculation used `tax / total` as the rate. That ratio is `r / (1 + r)`,
  so a 7.1% rate was quietly applied as 6.63% -- correct-looking, and wrong on
  every added dish. Found by reconciling the client's estimate against the server
  **to the cent**, not by reading the code.
- To-go checks had never been taxed at all: one code path wrote the lines without
  the recalculation the other path did. The same cent-level check found it, weeks
  of checks later.
- A batch edit across 25 files silently skipped 14 form labels, because the
  pattern it matched could not see them. It was caught only because the
  acceptance check was written independently of the edit. **Never let the tool
  that made the change define the test that accepts it** -- what it misses is
  precisely what it cannot see.

So the working rule is: nothing counts as done until it has been measured on a
real device, against real data, in the state the failure would actually occur in
-- offline, mid-sync, across midnight. Most entries in the journal are exactly
that measurement, and several record the assumption I got wrong before the number
corrected me.

---

## The problem worth talking about

Everything else follows from one requirement:

> **While the network or the power is out, no record is lost and no operation is blocked.**

A restaurant loses WiFi. Breakers trip. An iPad walks off with a server into the
back of the room. None of that is allowed to stop somebody seating a table, and
none of it is allowed to lose a check -- because there is no second copy anywhere.

That pushes the design into event sourcing and a single idempotent write path:

```
tap on the iPad
   -> write IndexedDB          (the UI answers immediately, online or not)
   -> append to the outbox     (with a client-generated op_id UUID)
   -> POST /api/sync           (or queue, and replay on reconnect)
   -> INSERT ... ON CONFLICT (op_id) DO NOTHING RETURNING op_id
        got a row  -> first write -> run the side effect, same transaction
        no row     -> already applied -> skip
```

Three rules hold the whole thing up, and are worth defending line by line:

1. **Every write goes through one endpoint.** One write path is one set of
   invariants. Two paths drift, and the hole that drift opens is only found at
   reconciliation.
2. **Idempotency comes from a database key, not an application check.**
   "SELECT then INSERT" is a TOCTOU race. And the `sync_op` row and its business
   side effect share one transaction -- a crash in between leaves a "recorded but
   never applied" hole that replay skips as a duplicate, which is silent data loss.
3. **Authorisation is enforced on the server at sync time.** Ops queued offline
   carry no role claim; the role comes only from a verified access token. The
   front end's role checks are UX, not a boundary.

---

## Five things I would bring to a whiteboard

### 1. An append-only log cannot express a deletion

Sync only appends: a client arrives with a cursor and gets everything newer. So
when rows are deleted **on the server**, nothing ever tells the devices -- each
iPad keeps showing checks that no longer exist, and the floor decides whether a
table is occupied from that stale mirror.

The fix is a self-heal: if a client's cursor is N and **not one record with
seq <= N is left in the log**, its log was truncated, so the server answers
`reset` and the device rebuilds its mirror from scratch.

Three details each cost real money if wrong:

- the test runs **before** the incoming batch is written, or the batch itself pushes `MAX(seq)` past the cursor and the gap becomes undetectable
- the client's queued ops are **accepted anyway** while it is told to start over -- the outbox may hold checks entered during the outage
- only rows already confirmed by the server are cleared; anything still in the outbox is untouched

The naive test, `cursor > MAX(seq)`, is wrong: `seq` is a bigserial and `DELETE`
does not wind it back, so after a purge one write from another device makes the
stale device look healthy forever.

*Verified end to end, including the dangerous path: an iPad with a check entered
offline, told to reset mid-flight, still landed that check on the server and got
it back to the cent.*

### 2. State replaces, facts append

Editing a check's guest count **replaces** the counts wholesale: two devices each
adding a guest offline would otherwise replay as +2, when the operator meant
"there are three".

Collecting money is the opposite. A check collected at $55.47 and then extended
to $62.46 needs the $6.99 **added** to what was collected, not written over it --
and the addition has to happen on the server, because the client's copy of "what
has been collected" may be stale, and overwriting a stale total loses money.

Same system, two write semantics, and confusing them turns a $6.99 discrepancy
into a $55.47 one.

### 3. Money arithmetic that cannot silently drift

Prices are snapshotted onto the check, so changing the menu never restates
history. Add-on prices are **folded into the line's unit price** rather than
being a second term in the totals -- so every money query stays
`SUM(qty x unit_price_cents)` and none of them can be missed when something changes.

Cross-checking the client's estimate against the server to the cent is what
caught a real bug: to-go checks had never been taxed, because one code path
called the line writer without the recalculation. The client's estimate included
tax, staff collected what the screen said, the server stored a pre-tax total, and
every one of those checks quietly sat in the month report as "payment does not
match".

### 4. Time zones charge the wrong price

The store charges a lunch price before 15:00 and a dinner price after. The
service period is resolved from the op's own client timestamp, not the server
clock -- a lunch check queued offline for two hours must not be charged as dinner.

A hard-coded UTC offset had the store two hours out, which would have charged
$15.88 instead of $14.05 for two hours every afternoon. Nobody had been
overcharged yet, purely by luck.

The interesting part is the fix's asymmetry, which I would defend in an interview:

> A tax rate is a **fact** -- that day really was charged at 7.1%, so it carries
> an effective date and past checks stay frozen.
> A time zone is an **interpretation rule** -- it answers "which day does this
> timestamp belong to". When the rule turns out to be wrong, the right move is to
> re-file the past along with it, not freeze the mistake behind an effective date.

The devices get a second safety net: the server publishes its UTC offset and each
iPad compares **offsets**, not computed dates -- by the time two time zones
disagree about the date, they have already been filing checks wrong for hours.

### 5. Collecting a quantity that cannot be observed

The long-term goal is forecasting buffet consumption to cut waste. Consumption is
**not directly observable**: all that exists are interval-censored events --
filled at t1, found empty at t2 -- and "found empty" is itself late, because
nobody watches a tray.

So the collection screen is designed for the model, not for the screen:

- three buttons and nothing else. One fill-level slider and nobody taps anything at peak, and *no record* costs far more than *a coarse record*
- `observed_at` is the device's own timestamp minus an explicit backdate, never
  the server's arrival time -- cooks tap after the fact, and arrival time feeds
  network latency and human delay straight into the model
- append-only with no undo: a mistap is corrected by logging the right one, because a fact table that can be edited cannot be trusted afterwards

The evaluation discipline is written down in advance: compare against a "copy the
same slot last week" baseline with MAE and proper time-series cross validation,
and **expect to lose to it at this data volume**. Reporting that honestly and
shipping the baseline plus an anomaly alert is the mature outcome.

---

## Architecture

```
   owner, at home                            the store
        │                          ┌────────────────────────────┐
   Cloudflare Access               │  iPad (front)  iPad (kitchen)
        │  tunnel, outbound only   │        │            │
        ▼                          │        └──── WiFi ──┘
  ┌───────────────┐                │                │
  │ admin API     │◀───────────────┤   ┌────────────┴──────────────┐
  │ (:8001)       │                │   │  Caddy  (TLS, LAN)        │
  └───────────────┘                │   ├───────────────────────────┤
                                   │   │  FastAPI  /api/sync :8000 │
   no inbound port is opened       │   ├───────────────────────────┤
   on the router                   │   │  PostgreSQL 16            │
                                   │   └───────────────────────────┘
                                   │            │  nightly encrypted backup
                                   └────────────┼───────────────────────▶ object storage
```

The critical path never leaves the LAN. The owner's remote access is the only
thing that depends on the internet, and it is the only thing that may fail.

**Data model highlights** (22 tables; the whole schema is in [DESIGN.md](DESIGN.md)):

| Table | Why it is shaped that way |
|---|---|
| `sync_op` | Every operation ever received, with its client timestamp and its author. Idempotency key, audit trail, and the source for per-check history replay -- no extra storage |
| `head_charge` | Admission **and** drinks, because both are charged per person; drinks are not order lines |
| `order_line` | A la carte and pickup dishes, with a price snapshot and the add-on money folded in |
| `tray_event` | Append-only refill events -- the only input the consumption model will ever have |
| `store_setting` | Single-row, CHECK-enforced: the store's time zone and business-day boundary, deliberately without an effective date |

---

## What is in the app

**Front of house** -- floor plan with live status, opening a table in three taps,
a la carte ordering with per-dish add-ons and hand-typed requests, to-go and
phone orders, transfer and merge, collect, top up, reversible voids, and a
per-check operation history reconstructed from the log.

**Kitchen** -- an order queue that works offline because the data is already
mirrored on the device, and the refill board.

**Manager** -- a month report with a sales calendar, daily tips, and two
reconciliation warnings that drill down to the exact checks behind the number
(the drill-down and the count share one SQL predicate, so they cannot disagree).

**Owner** -- prices, the menu, the add-on catalogue, the buffet board and
accounts, each with edit semantics chosen to match how that data behaves over
time.

**Everyone** -- a one-tap Chinese/English switch, with a dependency-free
catalogue and a fallback that degrades to readable text rather than a blank button.

---

## Running it

```bash
cp .env.example .env          # set POSTGRES_PASSWORD and JWT_SECRET
docker compose up -d --build
cd frontend && npm install && npm run dev
```

- Front end http://localhost:5173 · API docs http://localhost:8000/docs
- Development accounts and the full acceptance tests are in [RUNBOOK.md](RUNBOOK.md)

Testing on a real iPad (the Service Worker needs HTTPS, so this is not optional):

```bash
cd frontend && npm run build && cd .. && docker compose --profile lan up -d
```

---

## Where to look in the code

| Path | What is interesting |
|---|---|
| `backend/app/sync.py` | The idempotent write path, per-op SAVEPOINT isolation, the permission table, and the truncated-log detection |
| `backend/app/services/checks.py` | All the money: service charge, tax, top-up as an additive write, merges, voids |
| `backend/app/services/period.py` | The single definition of the business day and the service period |
| `frontend/src/sync.ts` | The outbox, the fetch watchdog, mirror rebuild, and the dead letter queue |
| `frontend/src/checks.ts` | The local mirror as a replay of the same ops the server applies |
| `frontend/src/businessDay.ts` | Business-day arithmetic on the device clock, and the drift check against the store |

Comments in this codebase are written for the next reader: they say what was
tried, what it cost, and why the current shape is the one that survived.

---

## Status

Steps 0-5 are done and the system runs in the store. Next is offline hardening
and chaos testing -- pulling the network cable at peak and pulling the server's
power, then verifying nothing was lost -- followed by deployment behind a real
domain, and the consumption model once there are 4-6 weeks of refill data.

| Document | Contents |
|---|---|
| [DESIGN.md](DESIGN.md) | Architecture decisions, the data model, the sync protocol, the permission matrix |
| [JOURNAL.md](JOURNAL.md) | The engineering journal: decisions, measurements and post-mortems, written the same day |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Hardware, network topology, the certificate chain, failure modes |
| [RUNBOOK.md](RUNBOOK.md) | Running it, migrations, accounts, debug hooks, troubleshooting |
| [HANDOFF.md](HANDOFF.md) | The constraints and traps somebody picking this up has to know first |

If you only read one other file, read [JOURNAL.md](JOURNAL.md) -- it is where the
wrong assumptions are recorded next to what actually turned out to be true.
