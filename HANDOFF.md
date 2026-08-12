# Handover

For whoever picks this project up next. **Read this first, then [DESIGN.md](DESIGN.md).**

---

## In one sentence

An operations log for a Chinese buffet restaurant (20 tables, 2 cooks).
**An offline-first PWA running on iPads in the store, with the server on the
store's own machine.** It deliberately **does not handle payment** -- it records
what is owed, and money is taken on the card terminal the store already has.

Written by an undergraduate as a portfolio project that the family's restaurant
actually uses. Both of those constrain it: the code has to survive a deep dive,
and the features have to work in the hands of staff at peak.

---

## Current state (2026-08-11)

| | |
|---|---|
| Commits | 53 |
| Files | 92 |
| Database tables | 22 |
| Alembic migrations | 13 (head `d7a2f4c19b60`) |
| Menu items | 143 (the real menu, taken off the store's takeout sheet) |
| Done | Steps 0-5, plus a lot of requirements added on the floor |
| Not started | **Step 6: offline hardening + chaos testing** |

To run it:

```bash
docker compose --profile lan up -d && cd frontend && npm run dev
```

- Computer: `http://localhost:8080` (simplest, no certificate involved)
- iPad: `https://restaurant.local` (over mDNS, with Caddy's local CA installed)
- Accounts are in [RUNBOOK.md](RUNBOOK.md): `manager` / `front` / `kitchen` / `boss`, password `<username>-dev-pw`

---

## Three hard constraints (understand these before changing anything)

### 1. Every write goes through `POST /api/sync`

There is no second path. One write path means one set of invariants; two would
drift apart, and the hole that drift opens only surfaces at reconciliation.

**The one exception**: `PUT /api/reports/tips` (a daily aggregate, online-only,
off the critical path). That is a considered exception, not a precedent --
anything that can happen offline still has to go through sync.

### 2. Idempotency comes from a database key, not an application-level check

```sql
INSERT INTO sync_op (op_id, ...) ON CONFLICT (op_id) DO NOTHING RETURNING op_id
```

Getting a row means this is the first write and the side effect is ours; no row
means skip. "SELECT then INSERT" is a TOCTOU race -- do not put it back.

**The sync_op record and the business side effect have to share one transaction.**
A crash in between leaves a "recorded but never applied" hole that replay then
skips as a duplicate, which is silent data loss.

**A corollary: deleting data on the server does not reach the devices.** Sync
only appends, deletion produces no op, so every iPad's mirror keeps showing
checks that no longer exist (and the floor decides whether a table is occupied
from that mirror). `/api/sync` therefore carries one self-healing rule: a client
whose cursor is N while **not one record with seq <= N is left in the log** has
consumed a truncated log, so the server answers `reset=True` and it empties its
mirror and pulls again. The test cannot be `cursor > MAX(seq)` -- `seq` is a
bigserial and DELETE does not wind it back. The details and the measurements are
in JOURNAL.

### 3. Authorisation is enforced on the server during sync, not in the front end

`_HANDLERS` in `backend/app/sync.py` is the only permission table.
Ops a client accumulated offline **carry no role claim**; the role comes only
from a verified access token.

---

## What is built

**Floor** (`FloorPlan.tsx`): a 20-table grid, opening a table (adult / child /
senior guests plus adult and child drinks), "order a la carte" for a whole table
skipping the buffet, and tapping a table for its detail.

**Check detail** (`CheckDetail.tsx`, **shared** by the floor and the check list):
collect (with the payment method), transfer and merge, add dishes, edit, void,
restore, view history, and **top up** (after adding dishes to a collected check,
record only the part not yet taken).

> ⚠️ Top-up (`add_payment`) and changing the payment method (`set_payment`) are
> **two different write semantics** and must not be merged: the first **adds** to
> what was collected (on the server), the second **replaces** wholesale. Get it
> wrong and a top-up wipes the earlier payment.
> State replaces, facts append -- the reasoning is in JOURNAL.

**To go** (`ToGoView.tsx`): Buffet To Go (by weight, the amount typed straight
into a keypad) and phone orders (menu picker plus the guest's name and the last
four digits of their number).

**Add-ons / special requests** (`ModifierSheet.tsx`): "customise" in the corner
of a dish card, with the usual requests (extra spicy free, add beef/chicken/shrimp
$2, add vegetables $1) plus a hand-typed request priced on the keypad.

> ⚠️ **Add-on money is folded into `order_line.unit_price_cents`**;
> `order_line_modifier` records the detail and takes no part in the arithmetic.
> Every money calculation stays `SUM(qty x unit_price_cents)`, so none of them
> change and none of them can be missed. Do not make add-ons a separate term
> again. `LocalLine.unit_price_cents` already includes them too -- do not add
> them twice.

**Check list** (`ListView.tsx`): cards, colour by status, filter tabs, and a
day summary. A closed check that **has not been paid in full** gets a dashed
amber treatment over the green "closed", plus a "not settled" filter tab and a
"N checks outstanding, $X" summary -- status and collection are two different
things, and green must not cover money that never arrived.

**Month report** (`MonthView.tsx`, manager/admin only): a calendar of sales,
quick year/month/day pickers, daily tip entry, the split by payment method, and
two reconciliation warnings (**no payment method** and **payment does not match**).

**Settings** (`SettingsSheet.tsx`, manager/admin only): the sales tax rate, and
**the store's time zone plus where the business day starts**.

**Owner's back office** (`AdminView.tsx`, **admin only**, stricter than
settings): per-head and drink prices, the price and availability of all 143
dishes, the contents and order of the add-on catalogue, and **accounts**.
Backend `api/admin.py`, `require_role("admin")`. The four blocks have
**deliberately different** edit semantics:

| | Semantics | Why |
|---|---|---|
| Per-head prices | A new effective date adds a version | The month report and reconciliation have to look up what a seat cost then |
| Dish prices | Edited in place | A check stores a `unit_price_cents` snapshot, so history cannot move |
| Add-ons | Replaced wholesale; removing = **deactivate** | `order_line_modifier` has a foreign key into it; deleting orphans history |
| Buffet board | Board replaced wholesale; clearing = **deactivate** | `tray_event` has a foreign key into it |

⚠️ About the buffet board: **renaming in place is the same dish; a different dish
means clearing the slot first.** Renaming would silently give the new dish the
old one's consumption history, and nothing in the data would show it afterwards.
A two-table design (layout + dishes) would be stricter; it was not done so the
owner's editing stays simple -- see JOURNAL.

The accounts tab changes display names and usernames and resets passwords. **A
password cannot be read** (argon2 hash, irreversible), only replaced. A reset
**revokes every session** that account holds -- the reason an owner changes a
staff password is that the person left, and without revoking, the refresh token
on their iPad works for another 30 days. Access tokens already issued cannot be
recalled (JWTs are not stored), so there is a window of up to 15 minutes.

**Business day** (`businessDay.ts`): the floor, the check list and the summary
all show **the current business day only**, and roll over on their own at the
boundary without a page reload. Checks carried over from an earlier day are
**not hidden** -- a banner at the top plus `CarriedOver.tsx` handle them
separately, because that is money not yet received.

**Operation history** (`CheckHistory.tsx`): replays `sync_op` step by step and
computes the difference at each one. **Nothing extra is stored** -- the data was
already in the audit log.

**Kitchen order queue** (`KitchenView.tsx`, the kitchen role's first tab):
a la carte dishes from the front appear by themselves, with add-ons, hand-typed
requests and how long they have waited; past 15 minutes the whole card changes colour.

> ⚠️ **No endpoint was added** -- what the kitchen needs was already in the local
> mirror, so this page has tickets offline too.
> "Done" is **display state on this device and is not synced**: sharing it would
> need a client-generated id per dish (local lines are rebuilt from op payloads
> and have no server line number).
> DESIGN.md says to watch two weeks of real use before investing further in this page.

**Refill logging** (`RefillView.tsx`, **on both the front and the kitchen**):
3 pages of 10 slots, three big buttons (full / half / empty), lunch and dinner
**switched by hand**, and "how long ago" on every slot.

> ⚠️ This is **the most important collection path in the project** -- the
> consumption model needs 4-6 weeks of data.
> The front can log too, because the person who notices an empty tray is usually
> a server; kitchen-only would lose most of the "ran empty" events, and those are
> the right-hand end of the censoring interval.
>
> ⚠️ `observed_at = client_ts - the minutes backdated`, **not the server's now()**.
> Backdating (0/5/10/15) is one-shot and resets after each entry.
> Append-only, **with no undo** -- a mistap is fixed by logging the right one.

**Language switch** (`i18n.ts` + `locales/zh.ts`): one tap in the top right
switches the whole app, and the choice is stored locally. No library.
**The code is written in English, and `locales/zh.ts` is the only place in the
project holding Chinese copy**; a missing entry falls back to the English, so
the worst case is an English word rather than a key or a blank button.

> ⚠️ **All code, comments included, is English.** Chinese is allowed in exactly
> two places: `frontend/src/locales/zh.ts` (the UI catalogue) and
> `backend/app/data/menu.json` (the store's dish names, category names and
> account display names -- data, not code). Seed values in a migration are the
> same case.
>
> ⚠️ **Dish, category and add-on names stay out of the catalogue**: the backend
> carries a `name_en` column for each, so the owner can add a dish on the pricing
> page. In the catalogue, adding a dish would mean a code change and a release.
> Role names and time-zone names arrive from the server **in English** and the
> front end runs them through `tr()` -- the server holds no UI copy.
>
> ⚠️ When adding a screen, **the unit of translation is a whole sentence**. Never
> split one across `<b>` tags and wrap each piece in `tr()` -- the grammar cannot
> be reassembled and it comes out half in each language.
>
> Two self-checks (both have been run from the scratchpad and are easy to rewrite):
> (1) scan the whole repository for CJK, which may only appear in those two files;
> (2) scan every `tr('...')` literal, each of which must have an entry in
> `zh.ts` -- otherwise a Chinese screen silently shows English.

---

## Pricing rules (all computed on the server; the client only estimates for display)

```
subtotal   = admission + drinks (per person, free refills) + a la carte lines
large party = +10% at five guests or more   <- party = max(buffet guests, drinks)
tax        = (subtotal + service charge) x rate   <- a mandatory service charge is taxable
total      = subtotal + service charge + tax
```

- Prices are snapshotted when stored, so changing the menu, a price or the tax rate **never restates a past check**
- The service period is resolved from the op's `client_ts`, not the server clock --
  a lunch check queued offline for two hours has to be charged the lunch price
- Lunch becomes dinner at 15:00 (as printed on the menu)
- **The business day starts at midnight**, in the time zone held in `store_setting`
  (editable under ⚙︎). That definition lives **only in
  `backend/app/services/period.py`** and is published to the front end by
  `/api/catalog` -- a second constant in the front end would make the check list
  and the month report split the day differently, and those two numbers agreeing
  is this system's only cross-check.

---

## ⚠️ Placeholder data still to confirm

Not printed on the menu; these are placeholders and **need confirming with the store**:

| | Current value |
|---|---|
| Tax rate | 7.1% (Douglas County NV, editable under ⚙︎) |
| **Store time zone** | **America/Los_Angeles (inferred from Douglas County NV, editable under ⚙︎)** |
| Child buffet, lunch / dinner | $6.99 / $9.99 |
| Senior buffet, lunch / dinner | $10.99 / $13.99 |
| Drinks, adult / child | $2.50 / $1.50 |

✅ Confirmed: lunch buffet $14.05, dinner buffet $15.88 (both printed on the menu).

⚠️ The time zone has to be checked with the store. **Getting it wrong charges the
wrong price** -- 15:00 is the lunch/dinner boundary, so being an hour out means an
hour of checks at the wrong price ($14.05 against $15.88). The "store time now"
line under ⚙︎ has to match the clock on the wall.

---

## Traps already hit (do not hit them again)

### Alembic autogenerate cannot be trusted -- five times now

1. **A CHECK constraint whose expression changed but whose name did not is not detected** (four times). Write the drop and create by hand.
2. **Adding a NOT NULL column to a table with rows needs a `server_default`**, or existing rows violate it.
3. **autogenerate never emits a data migration**; backfills are hand-written.
4. **The ordering rule**: relaxing a constraint means dropping it first; tightening one means fixing the data first.
5. **Migrations are COPY'd into the image** -- after generating one you have to `docker compose build api`, or `alembic upgrade head` silently does nothing.

The full command for generating a migration is in [RUNBOOK.md](RUNBOOK.md) (**the versions directory has to be mounted**).

### Front end

- **Fetch has no default timeout** -- a request in flight when the network drops never settles, wedges `inFlight` forever and no request is ever sent again. Now guarded by an AbortController and a watchdog.
- **Never read the outbox through an index** (`orderBy('client_seq')`): IndexedDB silently excludes records whose index key is invalid while `count()` still counts them -> the UI says there is work pending and the request body is empty.
- **When adding a field, never decide by exclusion** (`source !== 'dine_in'`) -- old rows lack the field and all land on the wrong side. Use a whitelist.
- **Never store a `synced` flag locally**; derive it from the outbox. A stored flag misses every op that is not open_check (their op_id is not the check_uuid).
- iOS has no Background Sync, so syncing has to happen on `visibilitychange` when the app returns to the foreground.
- **`1fr` in a grid is pushed open by its content's minimum width** (`1fr` is `minmax(auto, 1fr)`, and `auto` has a min-content floor). With only `grid-template-rows` written, the implicit column is `auto` too and does the same. If the parent is `overflow: hidden`, the excess is **silently clipped** -- that is how the right-hand column of the ordering keypad lost 5px. Any track that has to shrink is written `minmax(0, 1fr)`; the vertical equivalent is `min-height: 0`.
- `localhost` counts as a secure context -- **plaintext 8080 registers a Service Worker too**, so unregister it when a code change does not show up.

### Time

- **A fixed UTC offset is wrong.** It was hard-coded `STORE_UTC_OFFSET=-5` while the store is on Pacific time -- two hours out, so 13:00 counted as dinner and was charged the dinner price. Use an IANA name plus `zoneinfo`. A slim image does not guarantee a tz database, so the `tzdata` package is installed.
- The old 02:00 boundary **incidentally** absorbed daylight saving (the switch is at 02:00, outside the business day). Moving the boundary to midnight removed that cushion -- which is exactly why the real zone became mandatory.
- **The front end computes the business day from the device clock** (offline there is nothing else). When an iPad is not on store time, the few hours near the boundary are filed on the wrong day, silently. So the backend publishes the store's UTC offset and the front end compares **offsets rather than business days** -- by the time the days disagree it has been wrong for hours.
- In settings, **the time zone has no effective date and the tax rate does**. A rate is a fact (past checks stay frozen); a time zone is an interpretation rule (getting it wrong means re-filing the past).

### Network / deployment

- **SNI cannot be an IP** (RFC 6066). Over HTTPS to an IP the client sends no SNI, Caddy matches no site and refuses the handshake. Hence the mDNS hostname `restaurant.local`.
- The local CA lives in `ops/caddy-data/` (a bind mount, **unaffected by `docker compose down -v`**), or every database rebuild would mean reinstalling the certificate on the iPads. It holds a private key and is gitignored.

---

## How the work runs (the owner's preferences)

- The owner keeps correcting the business rules from real life (drinks can exceed
  the guest count, child drinks are priced separately, a collected check still has
  to be editable, merging triggers the service charge...). **These corrections are
  always right** -- there is a real restaurant behind them, which beats any
  reasoning. **Do not argue from what seems obvious; build it, then explain the
  consequences.**
- Every change ends with: it runs, it is **verified by actually testing it** (not
  "it should work"), `npm run build` plus a Caddy restart, and the build stamp
  reported so it can be checked on the iPad.
- The owner reads and understands design tradeoffs. **Explaining why something was
  chosen matters more than adding features** -- this is a portfolio project, and
  that is what a deep dive is about.
- Comments spell out the traps hit and the reasoning behind tradeoffs; the
  existing code is written that way and stays consistent.

---

## Next: Step 6

**Offline hardening + chaos testing (pull the cable, pull the power) + observability.**
See the roadmap in [GUIDE.md](GUIDE.md).

Step 5 is done: the kitchen order queue, refill collection, and a buffet board
the owner can edit. **Collection starts accumulating data the moment it ships**,
which is the prerequisite for everything predictive -- the consumption model
needs 4-6 weeks of samples, and a day not collected is a day gone.

The technical core (and the most interesting part of the project):

> Buffet consumption is **not directly observable**. All there is are
> **interval-censored events** -- filled at t1, found empty at t2 -- and "found
> empty" is itself late. The continuous consumption rate of each dish has to be
> inferred from those sparse, delayed, discrete events, then normalised per
> capita against how many people were seated at the time.

Evaluation discipline: **it has to be compared strictly against the "copy the
same slot last week" baseline**, using MAE, with proper time-series cross
validation. **It may well lose to the baseline -- that is not a failure**;
reporting that honestly, shipping the baseline and adding an anomaly alert is the
mature engineering call.

---

## Related documents

| File | Contents |
|---|---|
| [DESIGN.md](DESIGN.md) | Architecture decisions, data model, sync protocol |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Hardware, network topology, certificate chain, recovery |
| [RUNBOOK.md](RUNBOOK.md) | How to run it, migrations, accounts, debug hooks, troubleshooting |
| [GUIDE.md](GUIDE.md) | The step-by-step roadmap |
| [JOURNAL.md](JOURNAL.md) | **The engineering journal** -- decisions, measurements, post-mortems. The ammunition for a deep dive |
