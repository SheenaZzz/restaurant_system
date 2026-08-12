# Restaurant operations system -- design document

Dine-in and pickup operations for a small Chinese buffet restaurant
(20 tables, 2 cooks). No delivery, no third-party platforms, no payment handling.

---

## 1. Scope

| Stream | Description | Billed by |
|---|---|---|
| Dine-in buffet | Revenue = guests x price (different for lunch/dinner and adult/child/senior) | Head |
| Dine-in a la carte | Buffet guests may also order dishes | Dish |
| Pickup (phone) | The guest orders by phone and collects in store | Dish |

**Explicitly not built**: payment and collection, third-party delivery integration, rostering, payroll.

### Positioning: this is a record system, not a point-of-sale

The system only **computes what is owed**. It does not take payment, does not
talk to a card terminal, and does not print a payment receipt. Money continues
to be taken the way the store already takes it.

That has three direct consequences:

1. **Compliance burden drops to zero** -- no PCI, no card numbers stored, and a scope that stays controllable
2. **Closing a check has only `closed`, no payment status** -- closing means the record for that table is complete
3. **"Walkout" has a definition** = a table was opened, an amount is owed, and they left without settling -- still recordable and still attributable

> And precisely because it does not take money, the close-of-day
> **reconciliation gap** (what the system says is owed against what is in the
> card terminal and the drawer) becomes the only cross-check available -- which
> turns it from "a feature" into **the correctness test for the whole system**.

---

## 2. Core architecture decisions

### 2.1 The server runs in the store, not in the cloud

| Option | With the internet down | Verdict |
|---|---|---|
| Cloud hosted | The whole store stops | ✗ |
| **A small machine in the store** | Fully functional | ✅ Chosen |
| Hybrid (store primary + a read-only cloud replica) | Functional | A later extension |

**Reasoning**: every user is on the same WiFi and no order source needs the
internet. Putting the critical path behind an ISP buys nothing.

### 2.2 A PWA on the iPads, not a native app

- No App Store, no $99 developer account
- A change is live immediately (during iteration that may be several times a day)
- After "Add to Home Screen" it runs full screen and feels native to staff

**The cost**: iOS cannot reach USB or Bluetooth from a web app, so the printer
has to be a network printer driven **by the server** (see 4.4) -- which is a
cleaner architecture anyway.

### 2.3 The domain is modelled as an event stream

Core entities such as `tray_event` and `order_line` are append-only, which means
offline conflicts **cannot arise at all** on most paths (see 5.3).

---

## 3. Stack

| Layer | Choice | Reasoning |
|---|---|---|
| Front end | React + TypeScript + Vite + `vite-plugin-pwa` | React was already familiar |
| Local storage | Dexie (IndexedDB) | Manages local writes and the outbox queue |
| Backend | FastAPI (Python) | Same language as the analysis layer; OpenAPI out of the box -> generated TS types |
| Database | PostgreSQL 16 (Docker) | Transactions + JSONB + concurrent connections |
| Realtime | WebSocket (built into FastAPI) | 20 tables does not need a message queue |
| Reverse proxy / TLS | Caddy | Automatic Let's Encrypt and automatic renewal |
| Deployment | Docker Compose, `restart: always` | The store has no IT; it has to heal itself |
| CI | GitHub Actions: pytest + vitest | |
| Analysis / forecasting | Python (pandas / scikit-learn / statsmodels), nightly batch | Not realtime |

> **What is not used, and why**: no Kafka, no Redis, no Kubernetes, no
> microservices. A peak evening is about 200 checks and 10 concurrent clients,
> which a single Postgres handles comfortably. Every component has to be forced
> in by a constraint, or it is just attack surface in a deep dive.

---

## 4. Data model

### 4.1 Menu and prices

```sql
CREATE TABLE menu_item (
  id             BIGSERIAL PRIMARY KEY,
  name_en        TEXT NOT NULL,
  name_zh        TEXT NOT NULL,
  category       TEXT NOT NULL,          -- appetizer / entree / soup / dessert ...
  price_cents    INT,                    -- may be NULL for a buffet dish
  is_buffet_dish BOOLEAN NOT NULL DEFAULT FALSE,
  station        TEXT,                   -- wok / fryer / cold ...
  active         BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE service_period (
  id            BIGSERIAL PRIMARY KEY,
  business_date DATE NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('lunch','dinner')),
  opened_at     TIMESTAMPTZ NOT NULL,
  closed_at     TIMESTAMPTZ,
  UNIQUE (business_date, kind)
);

CREATE TABLE buffet_price (
  id             BIGSERIAL PRIMARY KEY,
  period_kind    TEXT NOT NULL CHECK (period_kind IN ('lunch','dinner')),
  guest_type     TEXT NOT NULL CHECK (guest_type IN ('adult','child','senior')),
  price_cents    INT  NOT NULL,
  effective_from DATE NOT NULL
);
```

### 4.2 Tables and checks -- two revenue entities on one check

This is the most important modelling point in the project: **a family on the
buffet plus one seafood dish is a single `check` carrying both a
`buffet_charge` and an `order_line`.**

```sql
CREATE TABLE dining_table (
  id    BIGSERIAL PRIMARY KEY,
  label TEXT NOT NULL UNIQUE,   -- "A1" ... 20 of them
  seats INT  NOT NULL,
  zone  TEXT
);

CREATE TABLE "check" (
  id          BIGSERIAL PRIMARY KEY,
  table_id    BIGINT REFERENCES dining_table(id),   -- NULL for pickup
  period_id   BIGINT NOT NULL REFERENCES service_period(id),
  source      TEXT NOT NULL CHECK (source IN ('dine_in','pickup')),
  status      TEXT NOT NULL CHECK (status IN ('open','closed','voided')),
  opened_at   TIMESTAMPTZ NOT NULL,
  closed_at   TIMESTAMPTZ
);

-- per-head charges: buffet admission plus drinks (per person, free refills)
CREATE TABLE head_charge (
  id               BIGSERIAL PRIMARY KEY,
  check_id         BIGINT NOT NULL REFERENCES "check"(id),
  kind             TEXT   NOT NULL CHECK (kind IN ('admission','drink')),
  guest_type       TEXT   NOT NULL CHECK (guest_type IN ('adult','child','senior')),
  qty              INT    NOT NULL CHECK (qty > 0),
  unit_price_cents INT    NOT NULL,
  -- drinks have adult and child tiers only; seniors pay the adult price
  CONSTRAINT ck_head_drink_tier
    CHECK (kind <> 'drink' OR guest_type IN ('adult','child'))
);

-- per-dish charges
CREATE TABLE order_line (
  id               BIGSERIAL PRIMARY KEY,
  check_id         BIGINT NOT NULL REFERENCES "check"(id),
  menu_item_id     BIGINT NOT NULL REFERENCES menu_item(id),
  qty              INT    NOT NULL CHECK (qty > 0),
  unit_price_cents INT    NOT NULL,
  notes            TEXT,
  status           TEXT NOT NULL CHECK (status IN ('placed','fired','ready','served','voided')),
  placed_at        TIMESTAMPTZ NOT NULL,
  fired_at         TIMESTAMPTZ,
  ready_at         TIMESTAMPTZ
);
```

> **How many people are seated is not stored separately** -- it is derived from
> the check's open and close times plus the qty on `head_charge` where
> kind='admission'. One table fewer, and one fewer piece of state that can disagree.

### Drinks: per person with free refills -> they are a second per-head charge

**Confirmed: drinks are charged per person with free refills (say $2.50 each).**

So a drink is **not** an `order_line` -- like admission it is charged once per
head, only with a different kind. Which is why the table is called `head_charge`
rather than `buffet_charge`.

A typical check:

```
check #1042  table A7  dine_in
├─ head_charge  admission  adult  x2  @ $18.99    <- admission
├─ head_charge  admission  child  x1  @ $9.99     <- admission
├─ head_charge  drink      adult  x2  @ $2.50     <- adult drinks (seniors same price)
├─ head_charge  drink      child  x1  @ $1.50     <- child drinks, priced separately
└─ order_line   Crab Rangoon     x1  @ $6.99      <- a la carte, goes to the kitchen
```

**Drinks have an adult and a child tier**, and seniors pay the adult price -- so
a `drink` row's `guest_type` only ever takes `adult` or `child` (enforced in the
database by `ck_head_drink_tier`). The front has a one-tap button that assigns
the tiers from the guest counts: adults + seniors -> adult drinks, children ->
child drinks.

A table of three all wanting a drink is `drink x3`; if only two do, `drink x2`.
**It has nothing to do with how many glasses were poured.**

> ⚠️ **The drink count may exceed the number of buffet guests.** Someone tagging
> along who does not eat but wants a drink is common (`admission x2 + drink x3`).
>
> That raises a definitional point: the `admission` count is **how many people
> eat the buffet**, not how many sit at the table. Consumption forecasting wants
> exactly the former (only eaters consume food), so the definition is right --
> but real occupancy would need a field of its own.

### Two consequences that follow

1. **Glasses poured is not consumption.** Charging per person means this table no
   longer contains "how much was drunk". Costing syrup or soda later would need
   another data source (recording tank changes, for instance).
2. **Drink cost scales with people, not with glasses** -- so a margin analysis has
   to use the ratio "drink guests / total guests" rather than a glass count. That
   ratio is itself useful to the owner (what share of guests pay for a drink).

### What is left for `order_line`

A la carte dishes and pickup orders. Whether something reaches the kitchen is
decided by `menu_item.station`:

```sql
SELECT * FROM order_line ol
  JOIN menu_item mi ON mi.id = ol.menu_item_id
 WHERE mi.station <> 'none';     -- the kitchen queue (bottled drinks and ready desserts are station='none')
```

> ⚠️ **Grouping in the UI is not the same as splitting a table.**
> "Enter the guests and the drinks together while opening the table" is a **UI
> requirement** -- the open-table screen is two sets of large steppers, and
> underneath it writes one `head_charge` table with two rows of different kind.
> That screen is the front's **most frequent action**, and its speed decides
> whether the system gets used at all.

### 4.3 Pickup

```sql
CREATE TABLE pickup_order (
  id            BIGSERIAL PRIMARY KEY,
  check_id      BIGINT NOT NULL REFERENCES "check"(id),
  customer_name TEXT,
  phone_last4   CHAR(4),          -- the last four digits only, never the full number
  promised_at   TIMESTAMPTZ,      -- the time the guest said they would come
  arrived_at    TIMESTAMPTZ,      -- when they actually did
  picked_up_at  TIMESTAMPTZ,
  status        TEXT NOT NULL
);
```

> **PII principle: do not collect what you do not need.** Only the last four
> digits, enough to identify the guest -- and neither the CV nor the docs should
> ever say "stores N customer phone numbers".

### 4.4 Buffet refill events -- the single source for everything predicted later

```sql
CREATE TABLE tray_event (
  id           BIGSERIAL PRIMARY KEY,
  menu_item_id BIGINT NOT NULL REFERENCES menu_item(id),
  event_type   TEXT   NOT NULL CHECK (event_type IN ('refill','half','empty','discard')),
  fill_level   REAL,              -- 0.0-1.0, recorded on refill/discard
  observed_at  TIMESTAMPTZ NOT NULL,
  recorded_by  TEXT
);
CREATE INDEX ON tray_event (menu_item_id, observed_at);
```

**This table is where the project's technical core lives**:

> Buffet consumption is **not directly observable**. All there is are
> **interval-censored events** -- filled at t1, found empty at t2 -- and "found
> empty" is itself late, because nobody stands watching a tray.
>
> The problem to solve: infer each dish's **continuous consumption rate** from
> those sparse, delayed, discrete events, then normalise per capita against how
> many people were seated at the time and forecast from there.

### 4.5 The sync log

```sql
CREATE TABLE sync_op (
  op_id       UUID PRIMARY KEY,       -- client-generated, the idempotency key
  client_id   TEXT NOT NULL,
  entity      TEXT NOT NULL,
  op_type     TEXT NOT NULL,
  payload     JSONB NOT NULL,
  client_seq  BIGINT NOT NULL,
  client_ts   TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at  TIMESTAMPTZ
);
```

Everything is kept, so state can be rebuilt by replay at any point, and it doubles as the audit trail.

`sync_op.user_id` makes **every operation attributable to a person** -- needed for
audit, and also the source for "who recorded this refill".

### 4.6 Accounts, devices and sessions

```sql
CREATE TABLE app_user (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('front','kitchen','admin')),
  password_hash TEXT NOT NULL,              -- argon2id
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- a device only carries a sync cursor and an audit trail; **it is not a principal**
CREATE TABLE device (
  id          BIGSERIAL PRIMARY KEY,
  client_id   TEXT NOT NULL UNIQUE,         -- 'ipad-front-01' / 'ipad-kitchen-01' / 'boss-phone'
  label       TEXT NOT NULL,
  first_seen  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ                   -- revokes every session on a lost device
);

CREATE TABLE session (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            BIGINT NOT NULL REFERENCES app_user(id),
  device_id          BIGINT REFERENCES device(id),
  refresh_token_hash TEXT NOT NULL,
  issued_at          TIMESTAMPTZ NOT NULL,
  expires_at         TIMESTAMPTZ NOT NULL,
  revoked_at         TIMESTAMPTZ
);
```

---

## 4.7 Identity and permissions

### Accounts, not devices

**Identity belongs to the account, not the device.** Any device can open the URL,
sign in, and get the interface for that account's role -- if the front iPad
breaks, grab any tablet, sign in, and carry on.

The device (`client_id`) is used for exactly two things: the sync cursor and the
audit trail. **It takes no part in authorisation.**

### Two shapes of sign-in

| | Store staff (front / kitchen) | Owner (admin) |
|---|---|---|
| Network location | LAN | **Exposed to the internet** |
| First sign-in | Username + password | Username + password |
| Session length | **Long** (a refresh token; no daily sign-in) | Short (15-minute idle timeout) |
| Quick switching | **A PIN** (see below) | None |
| Second factor | None | **Yes** (Cloudflare Access) |

**Why staff sessions have to be long-lived**: typing a password on a greasy iPad
at peak is not going to be accepted, and forcing it makes people abandon the
system altogether. So they sign in once and the refresh token keeps renewing.

**Quick switching (following what MenuSifu does)**: two or three servers may share
one device. The device remembers several signed-in accounts and switching is a
tap on an avatar plus a **4-digit PIN** -- the PIN exists to **attribute actions to
a person**, not as a security boundary. That way every `sync_op` traces back to
whoever did it, which is what makes walkouts, comps and voids meaningful.

**The owner remotely**: through Cloudflare Tunnel + Cloudflare Access (see
DEPLOYMENT.md 6), with another password check at the application layer, and an
automatic sign-out after 15 idle minutes.

### What happens to authentication offline (the key part)

With no network there is no server to verify against, so:

1. The client keeps reading and writing locally on its **cached session**, and the UI renders from the cached role
2. Every op produced offline carries `client_id` + `user_id`
3. **Authorisation is enforced by the server at sync time** -- the client's role check is UX, not a security boundary
4. If the session has been revoked, that batch is rejected at sync time and flagged

> **This has to be stated plainly**: permission checks in the front end are for
> people; the server's are what counts. Asked in an interview how permissions
> resist bypass, this is the answer.

### Permission matrix

| Operation | front | kitchen | admin |
|---|---|---|---|
| Seat guests / change the count | ✅ | ✗ | ✅ |
| Take an order | ✅ | ✗ | ✅ |
| Enter a pickup order | ✅ | ✗ | ✅ |
| View the order queue | ✅ | ✅ | ✅ |
| Mark a dish served | ✗ | ✅ | ✅ |
| **Record a refill event** | ✅ | ✅ | ✅ |
| Collect / close a check | ✅ | ✗ | ✅ |
| **Record an exception** (walkout / comp / void) | ✅ with a reason | ✗ | ✅ |
| **Approve an exception** (over the threshold) | ✗ | ✗ | ✅ |
| **Close-of-day batch** (tips / reconciliation) | ✅ entry | ✗ | ✅ entry + approval |
| Edit the menu / prices | ✗ | ✗ | ✅ |
| Reports / data export | ✗ | ✗ | ✅ |
| Account management / device revocation | ✗ | ✗ | ✅ |
| **Remote sign-in** | ✗ | ✗ | ✅ |

The reasoning:

- **Both ends log refills** -- a cook tapping while refilling is the natural case, and a server who notices an empty tray can log it too
- **The front can record exceptions but has to give a reason** -- a walkout happens at the front and never gets recorded if not recorded then; above a threshold (say $50) an admin approves it afterwards
- **The front enters the close of day and only an admin approves it** -- separating entry from approval is the most basic control there is

---

## 4.8 Exceptions (walkout / comp / void)

**This is where money leaks, and what the owner most wants to see.**

```sql
CREATE TABLE check_exception (
  id           BIGSERIAL PRIMARY KEY,
  check_id     BIGINT NOT NULL REFERENCES "check"(id),
  kind         TEXT NOT NULL CHECK (kind IN (
                 'walkout',    -- left without paying
                 'comp',       -- comped (a complaint / a staff meal)
                 'discount',
                 'void',       -- a dish returned (cooked wrong / no longer wanted)
                 'remake',     -- remade (spilled / ruined)
                 'other')),
  amount_cents INT NOT NULL,          -- the amount involved (prefilled from the check)
  reason       TEXT NOT NULL,         -- required, never blank
  recorded_by  BIGINT NOT NULL REFERENCES app_user(id),
  recorded_at  TIMESTAMPTZ NOT NULL,
  approved_by  BIGINT REFERENCES app_user(id),   -- an admin approves anything over the threshold
  approved_at  TIMESTAMPTZ
);
CREATE INDEX ON check_exception (recorded_at);
```

**The decisions that matter**:

- **A reason is required**, and the amount is prefilled from the check rather than typed -- less work at peak, and less nonsense entered
- **Attributable to a person** (`recorded_by`, from the PIN)
- **Anything over a threshold (say $50) needs an admin's approval afterwards** -- the most basic control, because exceptions are the only path that makes money vanish
- A walkout has to be **one tap on the spot**: the front notices an empty table with an unsettled check and two taps records it, or it never gets recorded once things get busy

---

## 4.9 The close-of-day batch

Modelled on "End of Day" in restaurant POS systems. The point is not computing
sales, it is **reconciliation**: **how far apart what the system says is owed and
what is actually in the card terminal and the drawer.**

```sql
CREATE TABLE daily_batch (
  id                      BIGSERIAL PRIMARY KEY,
  business_date           DATE NOT NULL UNIQUE,

  -- computed by the system
  computed_admission_cents INT NOT NULL,  -- buffet admission
  computed_drink_cents     INT NOT NULL,  -- drinks (per person)
  computed_item_cents      INT NOT NULL,  -- a la carte + pickup
  computed_total_cents     INT NOT NULL,
  guest_adult             INT NOT NULL,
  guest_child             INT NOT NULL,
  guest_senior            INT NOT NULL,
  check_count             INT NOT NULL,
  exception_total_cents   INT NOT NULL,   -- walkouts / comps / discounts

  -- entered by hand (from the card terminal and the drawer -- the system never touches payment)
  reported_card_cents       INT,
  reported_card_tips_cents  INT,
  reported_cash_cents       INT,
  reported_cash_tips_cents  INT,

  -- reconciliation
  variance_cents          INT,            -- owed against taken
  closed_by               BIGINT REFERENCES app_user(id),
  closed_at               TIMESTAMPTZ,
  approved_by             BIGINT REFERENCES app_user(id),
  note                    TEXT
);
```

**The flow (three minutes at the front, at the end of the evening)**:

1. The system totals the day automatically: sales, guests (adult/child/senior), check count, exceptions
2. The front types in four numbers: card total, card tips, cash total, cash tips
3. **The system computes the gap and highlights it** -- a non-zero gap needs an explanation
4. Submit -> the admin approves remotely

> **The system does not handle payment, so tips and takings have to be entered by hand.**
> That is not a shortcoming -- the **gap between what was entered and what was
> computed** is the entire value of the close of day. A gap that stays at zero
> means the process is healthy; a gap that wanders means something is wrong.

Tip distribution (pooling, or splitting by hours) is **not built for now**; only
the total is recorded. It can wait until the family asks for it.

---

## 5. Offline-first and the sync protocol

### 5.1 The invariant

> **While the network or the power is out, no record is lost and no operation is blocked.**

That is the project's one hard constraint, and what the chaos tests exist to prove.

### 5.2 The write path

```
a user action
  -> write IndexedDB (immediately; the UI responds at once)
  -> append to the outbox (with a client-generated op_id UUID)
  -> if online: POST /sync straight away
  -> if offline: the outbox grows and replays in batches on reconnect
```

### 5.3 The protocol

```http
POST /sync
{
  "client_id": "ipad-front-01",
  "since_cursor": 148213,
  "ops": [
    { "op_id": "0f2c...", "entity": "tray_event", "op_type": "insert",
      "client_seq": 91, "client_ts": "2026-08-08T18:32:11Z",
      "payload": { "menu_item_id": 42, "event_type": "empty", ... } }
  ]
}
```

```http
200 OK
{
  "applied":  ["0f2c..."],
  "rejected": [],
  "cursor":   148260,
  "changes":  [ ... changes from other clients since since_cursor ... ]
}
```

The server handles each op as:

```sql
INSERT INTO sync_op (op_id, ...) VALUES (...) ON CONFLICT (op_id) DO NOTHING;
-- the business logic runs only when a row was really inserted -> idempotent by construction, safe to retry
```

### 5.4 Conflict policy

| Entity | Mutable? | On conflict |
|---|---|---|
| `tray_event` | append-only | **Cannot conflict** |
| `order_line` (insert) | append-only | **Cannot conflict** |
| `order_line.status` | mutable | A monotonic state machine (placed->fired->ready->served); only forward moves are accepted |
| `check.status` | mutable | Last write wins, by server arrival order |
| `buffet_charge.qty` | mutable | Last write wins, by server arrival order, with `sync_op` keeping the trail |

> **The core argument**: once the domain is modelled as an event stream, most
> paths produce no conflict at all. Only a handful of mutable states need a policy.

---

## 6. The interface (by role, not by device)

After signing in, the interface renders from `role` -- one codebase, one URL.
If the front iPad breaks, any device can sign in and carry on.

### What `front` sees

| Screen | The requirement |
|---|---|
| **Floor overview** | All 20 tables on one screen, colour-coded: free / seated / to collect / exception |
| **Open a table (buffet)** | Adult/child/senior **plus drink counts**, two sets of large steppers, **done in three taps** |
| A la carte ordering | Bilingual dish names, added to the same check |
| Pickup orders | Replaces the paper slip; records promised time against actual arrival |
| Refills (secondary entry) | Log a tray found empty |
| **Exceptions** | Walkout / comp / void -- long-press a table to start, amount prefilled, reason required |
| Collect / close | Closes the check only; **it does not handle money** |
| **Close-of-day batch** | System totals + four numbers typed in + the gap highlighted, three minutes |

### What `kitchen` sees

| Screen | The requirement |
|---|---|
| Order queue | Read-only plus "served"; large type, readable from a metre away |
| **Refill logging** | Full / half / empty, three big buttons, **usable one-handed** (a cook taps it while refilling) |

> The kitchen iPad does both jobs. Having cooks log refills is more sensible than
> a dedicated iPad at the buffet -- refilling is already the cook's action.
>
> ⚠️ The order queue is **the first thing to validate**: in a two-cook kitchen, a
> server walking five steps and calling out may well be faster. Watch two weeks
> of real usage, and if nobody looks at it, cut it and keep the refill logging.

### What `admin` sees (remotely)

Everything `front` sees, plus: close-of-day approval and the reconciliation gap,
exception approval, sales and guest curves, waste estimates, restocking
suggestions, menu and price management, account management, and data export.

A phone browser is enough; **nothing to install** (see DEPLOYMENT.md 6).

---

### Borrowing from MenuSifu the right way

MenuSifu is one of the de facto POS standards for Chinese restaurants in the US,
and the family is probably used to how it works. **What is worth copying is the
flow and the information density** (how few taps a table takes, how the floor
overview is laid out, what the close of day looks like) -- having them demonstrate
the handful of actions they use most is far more useful than looking at screenshots.

**What not to copy**: it is a full POS, with payment, card terminals and a
hardware ecosystem. This is the **operations layer** and deliberately does not
touch payment. Trying to reproduce it one-for-one would never finish.

**Real UX constraints, not imagined ones**: the person using it may not be young,
may mix Chinese and English, has about three seconds at peak, and may be carrying
a plate. Buttons big, hierarchy shallow, mistakes undoable.

---

## 7. Analysis and forecasting (phase two)

### 7.1 The goal

Not live prompts -- **a weekly restocking suggestion plus a waste estimate**. A
batch job, not an online service.

### 7.2 The method

1. Estimate each dish's consumption rate lambda(t) from the interval-censored events in `tray_event`
2. Normalise per capita against the guests seated at the time
3. Stratify by period (lunch/dinner) and by weekday
4. Forecast the next day's and next week's usage per dish

### 7.3 Evaluation discipline (important)

**It has to be compared strictly against a baseline**, where the baseline is
"copy the same slot last week". Use MAE, with proper time-series cross
validation (no future data).

> ⚠️ Said up front: at this data volume **the model may well lose to the baseline**.
> That is not a failure. The correct conclusion is: "a proper evaluation was run,
> the model did not beat the baseline, so what shipped is the baseline plus an
> alert on unusual deviation."
> That is mature engineering judgement -- provided the measurement really happened.

---

## 8. Delivery order (8-10 weeks, in the store by week 3)

| Week | Content |
|---|---|
| 1 | Data model + FastAPI skeleton + sign-in/RBAC + Docker Compose + CI; the store server set up |
| 2 | PWA skeleton + **the HTTPS certificate chain working** (tackle it first) + floor overview + open-table screen + refill screen |
| **3** | **Those three screens go live, running in shadow -- the data clock starts** |
| **4** | **Close-of-day batch** (moved earlier, see below) + exception recording |
| 5-6 | A la carte + pickup + kitchen queue + WebSocket push |
| 7-8 | Full offline-first implementation + chaos testing (pull the cable, pull the power) + observability |
| 9 | Remote reports for the owner + Cloudflare Tunnel + nightly backups + operational hardening |
| 10+ | Consumption model + restocking suggestions, compared strictly against the baseline |

**Two reasons behind that ordering:**

- **Refill collection has to ship in week 3** -- the consumption model needs 4-6 weeks of data before it can even be attempted, which makes it the earliest thing on the critical path
- **The close of day moved up to week 4** -- the owner totals it by hand every night, so it is the most obviously painful and fastest-paying feature; and it forces the front's data to be complete, which drives adoption by itself

---

## 9. Baselines to measure first (unobtainable once it is live)

1. How often each buffet tray empties and how many refills a day (a week with pen and paper is enough)
2. How much is thrown away in a day (a rough "how many trays" will do)
3. Pickup: the time the guest said against when they actually arrived, and **the gap**
4. How long a dish sits between coming off the wok and being collected
5. Checks per hour at the dinner peak, and buffet guests seated per hour
6. How many missed or wrong orders in an evening

Items 1, 2 and 3 matter most -- they are the only source for every number in the final result.

---

## 10. Risks

| Risk | Response |
|---|---|
| **⚠️ Double entry** (the biggest adoption risk) | If a POS is already taking money, servers have to enter everything twice -> they will stop using it. See below |
| **The family says "it's fine" out of politeness and keeps using the old way** | Do not trust the review, look at the usage data. Two weeks in, check daily taps; if nobody is using it, stand in the store for an evening and find out why |
| A problem at peak affects real trading | Run **in shadow** for the first 2-3 weeks and never remove a working process first |
| Data loss | Nightly backups + a local copy + a cloud copy (see DEPLOYMENT.md) |
| Scope explodes and it never ships | Follow the order in section 8 strictly; cut features, never constraints |

### Confirmed reality: no POS, hand-written books, only a card terminal

**The double-entry risk is gone** -- there is no existing system to integrate with,
so this system is **the only record of truth**. That is the ideal case, and it
brings three hard consequences:

| Consequence | What it means |
|---|---|
| **Losing data = losing the day's books** | Reliability goes from "nice to have" to a hard requirement. Backups, crash recovery and the offline queue are the floor, not bonuses |
| **It has to be faster than pen and paper** | A few strokes on paper is quick. If opening a table takes more than 5 seconds it will be abandoned. That is the only adoption threshold |
| **There is no history** | A before/after comparison needs either a baseline recorded by hand starting now, or the last few weeks of the paper books entered manually |

**It also unlocks two things that were impossible before**:

- The store has **never had per-dish sales data** -- which dishes sell and which
  nobody has ordered in a year is immediately valuable on its own
- The owner totals the day **by hand every night** -- automating the close of day
  is the feature most likely to be appreciated and the easiest to quantify
  (literally "how many minutes saved")

> 💡 Which is why **the close of day is brought forward** rather than sitting in
> week 8. It happens every day, the pain is obvious, it pays off fastest, and it
> forces the front's data to be complete (otherwise the close does not
> reconcile) -- so it drives adoption by itself.

---

Related: [DEPLOYMENT.md](DEPLOYMENT.md) -- hardware, network topology, certificate chain, recovery
