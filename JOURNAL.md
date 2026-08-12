# Engineering journal

> **Written the same day; it cannot be reconstructed afterwards.** This journal is
> all the ammunition a deep dive needs -- the strongest answer in an interview is
> always "I measured X, so I changed it to Y, and it became Z".

Three kinds of entry, as they come up:

- **Decision** -- what was chosen / what was rejected / why / what it costs
- **Measurement** -- the actual numbers before and after
- **Failure** -- symptom / what I wrongly assumed / how I found it / root cause

---

## 2026-08-08 -- Step 0, environment

**Decision: move the project out of the OneDrive folder**
- Chose `C:\Users\Welcome\dev\restaurant_system` over `Desktop` (which OneDrive syncs)
- Reason: `node_modules` is tens of thousands of small files; live OneDrive sync
  slows builds, locks files and occasionally corrupts them, and `.gitignore` has
  no effect on OneDrive
- Cost: no automatic cloud backup -> a git remote covers it instead

**Decision: Docker Desktop rather than a native Postgres**
- Reason: production (an Ubuntu box in the store) runs Docker Compose, so keeping
  local identical avoids "it works on my machine"
- Cost: WSL2 on Windows, which is a heavy install

**Failure: assumed the Docker install had failed**
- Symptom: `C:\Program Files\Docker` did not exist and `docker` was not found
- Wrong assumption: the installer had failed
- Found it by: reading `%LOCALAPPDATA%\Docker\install-log.txt`, whose last line was `Installation succeeded`
- Root cause: Docker Desktop 4.85 defaults to a **per-user install** at
  `%LOCALAPPDATA%\Programs\DockerDesktop`, and a PATH change does not reach an already-open terminal
- Lesson: **read the install log before drawing a conclusion**

---

## 2026-08-08 -- Step 1, the walking skeleton

**Decision: build the skeleton before any business logic**
- Chose "one end-to-end loop containing no business logic" over "build the open-table screen and add offline later"
- Reason: iPad Safari requires HTTPS for a Service Worker, and the store's server
  is a private LAN address. If that cannot be solved, offline capability is zero
  and the architecture has to be replaced -- which has to be discovered **before**
  any business code exists
- Cost: two extra days, and the `ping_event` table it produced gets deleted in Step 2

**Decision: idempotency from a database key, not an application-level check**
- Chose `INSERT ... ON CONFLICT (op_id) DO NOTHING RETURNING op_id`
- Rejected "SELECT to see whether it exists, then INSERT" -- that is a TOCTOU
  race where two concurrent requests both find nothing and both insert
- Cost: whether the side effect runs depends on whether RETURNING gave a row, which reads slightly less obviously

**Decision: the sync_op write and the business side effect share one transaction**
- Rejected "record the sync_op, then commit the business write separately"
- Reason: a crash in between leaves a "recorded but never applied" hole, which
  replay then skips as a duplicate -> one row gone forever, and **undetectably**
- This is the most dangerous point in the whole offline design

**Decision: isolate a single failure with a SAVEPOINT**
- One bad op must not take the batch down. The front spends two hours offline and
  accumulates 200 ops; the third one being malformed cannot reject all of them

**Measurement (Step 1 acceptance)**
- Three taps online -> stored immediately, count 3 -> 6
- Stop the API container -> 10 taps -> outbox=10, local mirror=16, UI says "10 pending"
- Start the API -> replay -> **16/16/16, distinct_op=16, zero duplicates**
- Force-resend 3 already-applied ops -> `applied:0 duplicate:3`, count still 16
- After the computer slept for 35 minutes the containers came back with the data intact (named volumes work)

**Failure: TypeScript narrowed `crypto` to `never`**
- Symptom: `tsc` reported `Property 'getRandomValues' does not exist on type 'never'`
- Wrong assumption: a conflict between `@types/node` and lib.dom
- Found it by: the `in` narrowing in `'randomUUID' in crypto`, which makes TS think the else branch is unreachable
- Root cause: lib.dom declares `crypto` as always present and always having `randomUUID`
- Fix: widen explicitly with `globalThis.crypto as Crypto | undefined`
- **The real problem it uncovered**: `crypto.randomUUID` only exists in a secure
  context -- on an iPad over plaintext HTTP it is undefined. One more reason HTTPS is mandatory

**Failure: "sync failed" left on the status bar**
- Symptom: the outbox had reached zero (so the sync had worked) while the status bar still said failed
- Root cause: the "sync now" button did not go through the `report` callback, so it was showing the last automatic result
- Fix: manual and automatic share one reporting path
- Lesson: **in an offline system a lying status display is more dangerous than a
  crash** -- staff assume it did not sync and redo the work

---

## 2026-08-09 -- Three problems a real iPad exposed

**Measurement: HTTP against HTTPS (on the same iPad)**

| | HTTP `:8080` | HTTPS |
|---|---|---|
| Reopened from the home screen with no network | **Blank page** | **Opens normally, work continues** |

Conclusion: a Service Worker needs a secure context, and without it the interface
will not even load offline -- however intact the data in IndexedDB is, nobody can
reach the button.

---

### Failure A (the worst): syncing stopped completely, with no error

- **Symptom**: the UI showed "6 pending" and never decreased; it said "online"
  while stuck on "sync failed (offline?)"; repeatedly reopening the app changed nothing

- **The first diagnosis (wrong, and worth recording)**

  Caddy's logs showed request bodies of 55 bytes (`ops: []`) while the UI claimed
  work was pending, which suggested that `db.outbox.orderBy('client_seq')` was an
  index query and IndexedDB was silently excluding records with an invalid index key.

  **What disproved it**: lining up the timeline showed those 55-byte requests all
  happened before 20:00:44, while the first stuck record was created at 20:01:02 --
  **the outbox really was empty at the time**, and 55 bytes was entirely correct
  behaviour. I had read "normal" as "broken".

  Lesson: **line up the timeline before concluding.** Two symptoms coexisting is not causation.

- **The actual diagnosis**: counting every Caddy request showed **not one after
  20:00:44**. Nothing was being rejected -- **the client had stopped sending anything**.

- **Root cause**:

  ```ts
  let inFlight: Promise<...> | null = null
  export async function sync() {
    if (inFlight) return inFlight          // <- the permanent deadlock
    inFlight = doSync().finally(() => { inFlight = null })
    return inFlight
  }
  ```

  **Fetch has no default timeout.** Airplane mode went on with a fetch in flight,
  so that promise **never settles** -> `inFlight` stays set forever -> every later
  `sync()` returns the same dead promise and **never issues another request**.

  The timers kept firing and `visibilitychange` kept triggering, and all of them
  hit that one return. The UI froze on the last report before the deadlock, which
  reads as "it just will not sync".

  iOS suspends a background page rather than killing it -- so "reopening the app"
  restores the same wedged page state, however many times you do it.

- **Fix**:
  - an `AbortController` hard timeout (10s) on the fetch
  - an `inFlight` watchdog: past 30s it counts as dead, is dropped and resent
    (resending is safe -- `op_id` guarantees idempotency, which is exactly what that design buys)
  - a build timestamp injected and shown in the header, so on-device debugging shows at a glance whether the device has the new code

- **Lessons**:
  1. **Any network call without a timeout is a potential permanent deadlock.**
  2. **In an offline system, stopping silently is far more dangerous than
     crashing** -- a crash is noticed immediately, a silent stop is noticed at
     month-end when a check is missing.

- **Hardening kept along the way** (not this root cause, but a real gap):
  `takePending()` now uses `toArray()` plus a JS sort and depends on no index;
  `nextClientSeq()` is NaN-guarded. An invalid index key making a record invisible
  to `orderBy` while `count()` still sees it is a genuine IndexedDB trap -- it
  just was not this one.

### Failure B: offline displayed as "sync failed"

- `fetch` throws when there is no network -> the UI said "sync failed (offline?)"
- But offline **is not a failure**, it is normal queuing. A server who reads "failed" **redoes the work**
- Fix: distinguish `offline` from `error`, including the colour
- **Lesson**: a lying status is more dangerous than a crash

### Failure C: timestamps on cross-device changes were wrong

- `changes` were sent without `client_ts`, so the receiver fell back to `new Date()`
- Result: two hours of records queued offline all arrived on other devices stamped "just now"
- Fix: the server includes `client_ts` in `ChangeOut`

### A design gap fixed along the way: the dead letter queue

Ops the server rejected used to sit in the outbox **retrying forever**, so
"pending" never reached zero. They now move to a `deadletter` table and surface
as a red "N failed" badge -- **a failure nobody can see is a lost check**.

---

## 2026-08-09 -- HTTPS on the LAN: SNI cannot be an IP

- **Symptom**: the TLS handshake to `https://192.168.1.148` failed outright (curl reported `SEC_E_ILLEGAL_MESSAGE`)
- **Root cause**: RFC 6066 allows SNI to be a **hostname** only, never an IP
  literal. Over an IP the client sends no SNI -> Caddy matches no site -> the handshake is refused
- **Fix**: switch to the mDNS hostname `restaurant.local` (native on iOS, with a
  responder built into Windows 10+), which also survives a DHCP address change
- **Effect on decisions**: this directly strengthens the case for **buying a domain** in production rather than using a bare IP

---

## 2026-08-10 -- The business day: rolling over at midnight, and a time zone that nearly overcharged

**Trigger**: checks opened while testing on 8/9 were still on the floor and in the day summary on 8/10.

### The root cause was not "a missing archive feature", it was that the front end had no concept of a business day

The backend has always had `business_date_of()` and the month report aggregates by it. Three places in the front end queried everything with no filter:

| Where | Was | What that produced |
|---|---|---|
| `allChecks()` | `db.checks.toArray()` | The check list showed every check since opening day |
| `totalsOf(rows)` | Whatever it was handed | "Sales" was **the total since opening day** |
| `openChecksByTable()` | Every `status='open'` | Yesterday's unsettled checks held their tables forever |

The second is the dangerous one: the header clock said "10 August" while the
number underneath was all of history. **It looks completely normal** -- which is
worse than no summary at all, because nobody thinks to doubt it.

### It also uncovered a bug that would have overcharged guests

`STORE_UTC_OFFSET` defaulted to `-5` (EST) and docker-compose never set it. But
the store is in Douglas County NV -- **Pacific time**, UTC-7 in August. Two hours out:

- **13:00** real store time -> the backend computed 15:00 -> **the dinner price two hours early**
- A lunch check at $14.05 charged at the dinner $15.88

Checking the existing data: no check fell in the 13:00-15:00 PT window, **so
nobody was actually overcharged**. Pure luck -- a few more days of testing and it
would certainly have happened.

### Decisions

**1. The day boundary is midnight** (it was 02:00)

The cost, stated plainly: a check entered after midnight lands on the next
business day. The store closes at 20:30, so entry across midnight is not normal.
The boundary is a setting now, so if it does happen it can go back to 2.

**2. A fixed offset becomes an IANA time zone name**

The old 02:00 cutoff had **incidentally** been absorbing daylight saving -- the
switch is at exactly 02:00, outside the business day, so a wrong offset was
invisible. Moving the boundary to midnight removed that cushion, so the real zone
became mandatory. `zoneinfo` + `tzdata` (a slim image does not guarantee a tz database).

**3. The time zone and the boundary are settings, not env vars**

Changing an env var means rebuilding the container, and the store has no IT.

The design point that matters -- **it is deliberately stored differently from the tax rate, with no `effective_from`:**

> A tax rate or a dish price is a **fact**: that day really was charged at 7.1%,
> so past checks have to be frozen.
> A time zone or a day boundary is an **interpretation rule**: it answers "which
> day does this timestamp belong to". When a rule turns out to be wrong (a
> hard-coded UTC-5, say), the right move is to **re-file the past along with it**
> rather than freeze the mistake. An effective date would preserve the error
> forever and make it impossible to say which stretch was right.

The cost: changing the time zone moves checks near the boundary to a different day in the month report. The UI says so explicitly.

**4. The floor clears, but an unsettled check is never hidden**

The choice was "clear the floor and give them their own entry point". There is
one thing here that cannot be fudged: what clears is the floor, not the books. A
table was opened, an amount is owed, nothing was collected -- that is money not
yet received, and this system is the store's only record, so disappearing from
the screen means nobody will ever think of it again.

So the banner stays up until it is dealt with, rather than appearing once as a notification.

### A real edge that clearing the floor exposed

The server has a partial unique index `uq_check_open_per_table` (one open check
per table). After the floor clears, yesterday's check **still holds that table on
the server** -- opening a new check there today is rejected and lands in the dead
letter queue. The table looks free, and the tap "does nothing".

Handled the same way as the `restore_check` case: the front end catches it first
and says something actionable ("A2 still has an unsettled check from 9 August,
$51.14 -- deal with it").
**The constraint guarantees correctness; the message makes it actionable.**

### Another safety net: the device's time zone is not the store's

The front end computes the business day from **the device clock** (offline there
is nothing else). The development machine is on America/Chicago while the store
is Los_Angeles -- two hours apart.

The first idea was "warn when the computed business days disagree", which is
wrong: two time zones produce the **same** business day for most of the day and
only diverge for the few hours near the boundary. Waiting for divergence means a
few hours a day are silently filed wrong -- and those hours are the dinner peak.

Changed to: the backend publishes the store's UTC offset and the front end
compares offsets, staying red for as long as they differ.

> A small trap hit here: the banner originally checked once a minute. On a cold
> start the cache still holds the **previous** catalog (without the new field), so
> it decides there is no drift; once FloorPlan refreshes the catalog it would
> still take another minute to notice -- and that minute is exactly when someone
> has just opened the iPad and is most likely to seat the first table. Changed to 10 seconds.

### The local mirror gained archiving

The mirror only ever grew, while the floor and the check list poll every 2
seconds and scan the whole table to work out business days. Tens of thousands of
rows a year is noticeably slow on an iPad. It now keeps the last 7 business days,
and **all three conditions have to hold before a row is deleted**: settled, no op
in the outbox references it, and older than the window. Only this device's cache;
the server keeps everything and the month report still finds it.

### Measurement

| | Before | After |
|---|---|---|
| Rows in the check list | 9 (including four from 8/9) | 5 (8/10 only) |
| "Sales" | Everything since opening day | $238.50 for the day |
| Tables open on the floor | 3/20 (including A2 from 8/9) | 3/20 (A2 moved out) |
| Carried over | Nowhere to be seen | A banner: 1 check, $51.14 |

**Tested across midnight** (without reloading the page, pushing the device clock to 8/11 00:01):
within 4 seconds the floor turned over to "Tuesday 11 August", tables open went to
0/20, and carried over became 6 checks totalling $289.64.
All six survived, every one of them reachable from the handling screen.

---

## 2026-08-10 -- Top-up: why it cannot reuse "change the payment method"

**Trigger**: the most common cause of "payment does not match" in the month
report is **dishes added after collecting** (the system deliberately allows
editing a closed check). The check goes from $55.47 to $62.46 while the collected
amount stays at $55.47. The requirement: when settling again, show only the part
not yet paid.

### It looks like a UI requirement and is actually about write semantics

The existing "change the payment method" (`set_payment`) **replaces wholesale**.
Putting a $6.99 top-up through it would **wipe** the original $55.47 -- turning a
$6.99 discrepancy into a $55.47 one. So the first step is admitting these are two
different operations:

| Operation | When | Semantics |
|---|---|---|
| Change the payment method | The method was recorded wrong (cash when it was card) | **Replace wholesale** |
| Top up | Dishes were added after collecting | **Add to what was collected** |

### The addition has to happen on the server

The client says "this much was collected now" and **never "this much in total"**.
Its copy of the collected amount may be stale (another device just topped up),
and overwriting with a stale total loses money. The server adds to its own
current value.

That looks contradictory to `modify_check` choosing "replace, not increment", but
they are not the same category: changing the guest count describes a **final
state** (two devices each adding one person mean "there are three", and
increments would make it five); collecting records **a fact that has already
happened** (two servers each took part of it, and both count).
State replaces, facts append.

### No payment_event table was created

Turning payments into an event stream was considered. But every top-up is already
a `sync_op` carrying its `client_ts` and its operator -- "this one was collected
in two goes, $55.47 on card then $6.99 in cash" replays out of the existing
operation history. Same reasoning as the check history: **the data is already in
the audit log, so it does not need storing twice.**

The payment method (cash/card/mixed/other) became **derived** from the three
amount buckets, and a client-supplied method is ignored -- one card payment plus
one cash payment is mixed, and that is not the client's call.

### Edge cases (all tested)

| Case | Handling |
|---|---|
| Top-up greater than outstanding | Rejected, with the outstanding amount in the message |
| Top-up of 0 | Rejected |
| Topping up an already-settled check | Rejected: "this check is fully paid" |
| "Other" with no note | Rejected |
| A voided dish leaving an overpayment (negative outstanding) | **No automatic refund.** The system does not touch money, and only the person who handled it knows what was actually refunded; the screen says where the gap is and the refund and the correction are theirs |

### Measurement

C4: $51.37 owed, $39.37 taken on card -> a $12 cash top-up -> mixed(1200+3937)=5137,
and it left the day's "payment does not match" count.
A5 was walked through in the UI: the sheet's large figure showed **$7.44 rather
than $112.25**, with three lines breaking out owed / already collected / outstanding.

---

## 2026-08-10 -- Month report day detail: a warning has to open, and the keypad has to fit

**Two requirements straight from real use**: the tip keypad was cramped enough to
need scrolling, and "2 voided" / "2 mismatched" gave a number with nothing to act on.

### A drill-down and the number it explains have to share one predicate

The new `/api/reports/day-checks?date=&kind=` and the day aggregate `_SQL` that
computes `mismatch_count / unpaid_count / voided_count` are written once
(`_PER_CHECK` + `_KIND_WHERE`).

Without that, sooner or later the report says 3 and the drill-down lists 2. That
is worse than offering no drill-down -- it makes **every** number suspect, and
this system's entire value rests on the numbers being trustworthy.

Measured: mismatch 2 lists 2, voided 2 lists 2, unpaid 0 is empty.

### Layout: the real problem was not "too tall", it was the main button in the wrong place

The first attempt only moved the tip keypad into the right column, and measuring
showed it **still scrolled** (733 > 632). The right column is 530px on its own,
and turning it sideways does not make it shorter.

The actual fault was that "save tips" was a `linkbtn` inside the tip box while
the bottom action bar only had "close" -- the prominent button is not the one you
want, and a tall keypad pushes the real one off screen. **The same mistake as the
settings sheet** (change the time zone, tap save at the bottom, and the tax rate
gets saved).

Changed to: the h2 and the bottom action bar are fixed, the middle scrolls, and
"save tips" is promoted to the primary button at the bottom. Tested at 1280x720
and at 768x1024 in portrait: **no scrolling needed, and the save button is always visible.**

> One lesson is enough: **when a screen has more than one save action, the most
> prominent one has to be the main one.** This project has now made that mistake twice.

### An out-of-date note fixed along the way

The bottom of the day detail used to say "checks before 2 AM count as the
previous day". Once the boundary moved to midnight and became a setting, that
sentence was false. It now says "the boundary is in Settings" --
**do not hard-code a value that changes**; an out-of-date explanation is worse than none.

---

## 2026-08-11 -- Add-ons: folded into the unit price rather than a second money path

The requirement: opening a dish should offer extra spicy, add beef/chicken/shrimp
($2) and add vegetables ($1), plus a hand-typed request priced on the spot.

### The key choice: add-on money is **folded into order_line.unit_price_cents**

The alternative is letting add-ons take part in the totals themselves. That would
mean changing, at the same time: the total owed, the service charge base, the tax
base, four or five queries in the month report, the day drill-down, the local
estimate... and missing any one of them is a hole that only surfaces at reconciliation.

Folded into the unit price, every money calculation stays
`SUM(qty x unit_price_cents)` and **not one line changes**. What was added is
stored separately in `order_line_modifier`: the check and the kitchen have to see
it, and "how many guests add shrimp" stays answerable -- which is exactly what
folding the price in would otherwise lose.

The cost: `unit_price_cents` no longer equals the menu price. So the comment says
so outright, and the local `LocalLine.unit_price_cents` is marked "already
includes add-ons" so nobody adds them a second time.

Charged **per portion**: two dishes with shrimp is twice the money. Folding into
the unit price gives exactly that semantics for free.

### Two classes of price authority

| Source | Who sets the price |
|---|---|
| From the catalogue (extra spicy, add shrimp...) | **The server looks it up**; whatever the client sent is ignored |
| Typed by the front | The client sends it, because that number **only exists at the counter** |

The second is the same class of exception as weighing Buffet To Go -- not
laziness, but that a request a guest makes on the spot can only be priced on the
spot. So it is attributed to a person (sync_op carries user_id) and can be traced.

### The cart can no longer be "dish id -> quantity"

The same dish can appear several times with different add-ons (one with shrimp,
one extra spicy). A Map merges them into one line -- and the guest gets the wrong
food. Changed to an array, where only identical add-ons merge quantities.

### The fast path was preserved

Tapping the dish name adds one immediately, with no sheet; "customise" in the
corner of the card is for add-ons. Most dishes at peak carry no request, and a
sheet plus a confirm tap on every dish is hundreds of extra taps a night.

### It also uncovered a bug where to-go checks were never taxed

Verifying that the local estimate and the server agreed to the cent, they did
not: 4188 locally against 3910 on the server, a difference of 278, which is
exactly the tax. Digging in, `open_togo_check` called `_add_lines` but
**never called `_recalc_service_charge`** -- every to-go check had `tax_cents` of 0.

| source | Checks | Tax total |
|---|---|---|
| dine_in | 16 | $53.12 |
| buffet_togo | 3 | **0** |
| phone_order | 3 | **0** |

The damage was more than the missing tax: the client's estimate **does** include
tax, staff collect what the screen says, and the server recorded a pre-tax total
-> the check immediately reads as overpaid and the month report keeps flagging it.
And `add_order_lines` already recalculated, so the same kind of check was taxed
two different ways depending on the path.

One line added. The service charge is unaffected -- `_party_size` is 0 for to-go,
so the function returns 0 by itself with no special case.

Measured after the fix: two Kung Pao Chicken with shrimp = 1320 x 2 = 2640,
service charge 0, tax 187, total 2827, matching the arithmetic by hand.

---

## 2026-08-11 -- The owner's pricing page: three kinds of data, three ways to edit

The owner has to be able to change "all the prices". That sounds like one CRUD
screen and is actually three different **temporal semantics**, and writing them as
one is guaranteed to get a side wrong.

| | Semantics | Why nothing else works |
|---|---|---|
| Per-head and drink prices | A new effective date adds a version; editing on the same date overwrites it | The month report has to be able to look up "what a seat cost that day". But editing three times in one day should not leave three versions, or `effective_from` uniqueness and readability are both ruined |
| Dish prices (143 of them) | Edited in place | A check stores an `order_line.unit_price_cents` snapshot and never reads the menu table -- another version table would be pure liability |
| The add-on catalogue | Replaced wholesale, order = array index | The owner drags the order. Order is a property of the list, not of a row, and per-row PATCH cannot express it |

**Deleting an add-on becomes `active = False`, not DELETE.**
`order_line_modifier` has a foreign key into it -- delete it and last month's
"add shrimp" becomes a row pointing at nothing, and that check's detail will not
open. A deactivated row stops appearing when ordering; past checks still show its name.

**Stricter permissions than the settings sheet**: settings is manager/admin, this
page is admin only. The reasoning is plain -- a front manager needs to set a tax
rate's effective date during service, but should not be able to change dish prices.

**Failure: `set_modifiers` deactivated the rows it had just created**
- Symptom: newly added add-ons disappeared the moment they were saved
- Wrong assumption: the front end had not refreshed
- Root cause: the logic was "collect the ids in this submission and deactivate
  anything not in it". A newly created object has `id` of `None` before
  `flush()`, so `None not in seen_ids` is always true -> a row just added to the
  session judged itself deleted
- Fix: track **objects** rather than ids, and compare after `db.flush()` has assigned the keys

---

## 2026-08-11 -- The language switch: the unit of translation is a sentence, not a text node

The store has English-speaking staff. The requirement was one tap in the top right that switches everything.

**Decision: no i18n library, and the catalogue is keyed by the source string** (gettext's msgid approach).

- What you read in the JSX is the sentence itself; inventing `settings.tz.hint`
  only adds a layer of indirection nobody can resolve by reading
- A missing entry falls back to **readable text**, not to a key -- the worst case is still usable
- The cost: editing the copy means changing a key. Acceptable, because the copy
  rarely moves, and a script scans for strings that are used but absent from the
  table, so anything missed gets caught

**Decision: dish, category and add-on names stay out of the catalogue.**
They are **data**, not copy -- the backend carries a `name_en` column for each,
and the owner edits them on the pricing page. In the catalogue, adding a dish
would mean waiting for a code change and a release.

**Failure (the same root cause twice): the batch rewrite matched the wrong unit**

A script wrapped the strings in the JSX into `tr('...')`, matching on "an
element's complete text child". It came off the rails twice:

1. **Sentences split across `<b>` tags were handled piece by piece**, which comes
   out half in one language and half in the other. Root cause: the unit is a
   sentence, and `<b>` cuts one sentence into three text nodes that cannot be
   reassembled grammatically. The fix was merging each into one string (and
   trimming them while there -- most of those paragraphs explained design, and the
   reader makes exactly one decision from them)
2. **`<label>Name<input/></label>` was skipped entirely**: text followed by an
   element is not a "complete text child". Fourteen form labels across seven
   files, all missed -- and **they only appear after ordering**, so casual tapping
   never reaches them

The second one was caught from a screenshot. The lesson: a batch rewrite needs an
**independent check**, and the rewrite script's own rule cannot be the acceptance
criterion -- what it misses is precisely what it cannot see. The check that
followed scans each page's `innerText` in the browser, which is unrelated to the
rewrite rule, and it immediately turned up everything left on the Settings page.

**Measurement**: 305 entries in the catalogue, 239 used by the interface (the rest
are reached through `tr(variable)` for role names and server error strings),
0 missing; a scan of the five main pages and the settings sheet found 0 residue
(other than notes the owner typed in, which are data).

---

## 2026-08-11 -- Clearing test data: deleted on the server, still on the iPad

Three days of test checks (28 of them, 79 ops) cleared in one go. Deleting is one
SQL statement; the real problem comes after: **nothing carries a deletion on this
server out to the devices.**

The sync protocol is **append-only**: the client arrives with a cursor asking for
anything newer, and the server returns a batch of changes. A deletion is not a
change -- it produces no op, so it is never sent. Those 28 checks stay in every
iPad's local mirror and the screen shows **checks the server no longer has**. And
this is not cosmetic: the floor decides whether a table is occupied from that mirror.

There was only a manual button for it (⚙︎ "reset local data"), which means
clearing data once requires visiting every device. Replaced with automatic detection:

**The test**: the client says it has consumed up to seq = N, and **not one record
with seq <= N is left in the log**. That cannot happen in normal operation -- a
cursor of N means 1..N existed and one of them is still there.

The first version was `since_cursor > MAX(seq)`, which is **wrong**: `seq` is a
bigserial and DELETE does not wind the sequence back. After a purge, one write
from another device is seq 80, so the device sitting at 79 looks fine and never
agrees again.

**Three points that all have to be right** (each one wrong loses real money):

1. **The truncation test runs before this batch of ops is written.** Written
   first, the batch itself pushes MAX(seq) past the cursor and it can never be detected.
2. **The client's ops are accepted even while telling it to start over.** The
   outbox may hold checks really entered while the network was down. Dropping
   them for cleanliness is dropping the store's money.
3. **Only synced=1 mirror rows are cleared.** synced=0 means it is still in the outbox and has never been sent.

**A silent bug in the manual reset button, found along the way**: `/api/sync`
normally filters out ops **produced by this device** (so it does not re-apply its
own writes). So zeroing the cursor and pulling again returns only other devices'
checks -- this iPad's own would be missing forever, and silently. A `resync` flag
now tells the server not to filter for that round.

**Measured** (not "it should work"):

| Scenario | Result |
|---|---|
| Cursor 79, mirror of 28 checks, server cleared | Within one heartbeat the mirror is empty and the floor is back to 0/20 |
| Stop the API -> open A1 offline -> push the cursor back to 79 -> start the API | That outbox check **reached the server**, came back from the server after the reset, `synced=1`, $34.01 to the cent |
| Delete that check too | A second automatic reset; mirror empty, outbox empty, dead letters empty |

---

## 2026-08-11 -- The accounts page: what can be changed and what cannot

The owner wanted to "see and change every account's name and password". Names
yes; a password **cannot be seen** -- what is stored is an argon2 hash and it is
irreversible. That is not a missing feature: being able to read one back would
mean whoever dumps the database can too. The page has to say so, or the owner
will assume they simply cannot find it.

**Changing a password has to revoke sessions, or it does nothing.**
The typical reason an owner changes a staff password is that the person left. The
refresh token on their iPad keeps renewing for another 30 days -- without
revoking, they can still sign in after the change. So `set_password` marks every
unrevoked session on that account revoked.

A 15-minute window remains: access tokens already issued are JWTs, are not
stored, and cannot be recalled. That is a **deliberate trade** -- cutting it to
zero means a database lookup on every request, and "answer local requests quickly
while the network is down" is a premise of this system.

**Three small decisions:**

- **The password field is not masked.** The owner reads it out to the member of
  staff, and masking only hides their own typos. This is not them entering their own password.
- **The floor is four characters.** The threat is "someone who left can still
  sign in", not brute force from the internet -- this server only lives on the
  store LAN. Forcing complex passwords really produces a sticky note on the till, which is worse.
- **Usernames are stored lower-cased.** Sign-in is an exact match, so `Admin` and
  `admin` would be two accounts, which only ever produces "I typed it right and it will not let me in".

---

## 2026-08-11 -- Step 5, refill collection: designed for "can this be modelled later", not "is this easy to render"

The value of this step is not the interface, it is **starting collection as early
as possible** -- the consumption model needs 4-6 weeks of samples, a day not
collected is a day gone, and it cannot be back-filled. So every tradeoff leans
toward "get it recorded".

### The board is a new table, not the twelve dishes in the menu

Twelve menu rows are flagged `is_buffet_dish`, but far more than that sits on the
buffet, and the owner has to be able to change it at any time. More
fundamentally: **a menu dish is something that can be ordered, has a price and
goes on a check; a dish on the buffet has only a position and a rate of
consumption** -- their lifecycles have nothing in common. So
`buffet_dish(period_kind, page, pos, name)` was created and `tray_event`'s foreign
key moved from `menu_item` onto it -- while it was still an empty table, because
changing it later would need a data migration.

**The same dish is two rows, lunch and dinner.** That looks redundant, and in fact
they are two different consumption processes (different crowd, length and refill
pace). One row would only have to be split again in the model.

### A trap that structure cannot prevent, only a rule can

When the owner edits the board and changes slot 5 from General Tso's Chicken to
Kung Pao Chicken, is that a **rename** or a **replacement**? Edited in place by id,
the new dish silently inherits the old one's entire consumption history -- and
that contamination is invisible in the data afterwards.

The clean solution is two layers, a layout table and a dish table, where
replacing a dish means changing a foreign key. But that means the owner picks
from a dish library and then places it in a slot -- two layers of interaction for
a 3x10 board. What was chosen is a single table plus one rule written on the
screen: **renaming is renaming; to swap in a different dish, clear the slot
first**. Clearing means deactivating (`active=false`), and old records still point at it.

This is one of the few places in the project where the stricter approach was
understood and not taken, so it is recorded here.

### Three buttons, no fill-level slider

`tray_event.fill_level` exists but is always empty. One more slider and nobody
taps anything at peak, and **"no record" costs far more than "a coarse record"**
-- the first is missing data, the second is one notch less precision. `discard`
(thrown away, the only source for waste estimates) is the same case: once these
three are running smoothly.

### The observed time is client_ts minus the minutes backdated, not the server's now()

Cooks usually tap **after** the fact. `observed_at` directly sets the width of the
censoring interval, and using "when the server received it" feeds network latency
and human delay into the model together.
So: the client only reports **how many minutes back** (0/5/10/15) and the server
subtracts from that op's own `client_ts` -- one clock, so "device time" and
"observation time" cannot drift apart as two separate sources.

Backdating is **one-shot** and jumps back to "now" after each entry. As a
persistent mode, nobody would remember having set it ten minutes earlier and the
next few dozen records would be silently filed in the past.

### Append-only, with no undo

Tapped the wrong one? Record the right one straight after: two events seconds
apart are distinguishable when modelling, while a fact table that can be edited
loses all its credibility -- nobody could say afterwards whether a row was
recorded at the time or changed later.

### Orders reaching the kitchen: no endpoint was added

What the kitchen needs is **already in every device's local mirror** (sync sends
all the checks); the only thing missing was a screen. So this page has tickets
offline too.

"Done" is deliberately **display state on this device** and is not synced: sharing
it would need a client-generated id per dish (local lines are rebuilt from op
payloads and have no server line number), which is a whole change of its own.
And DESIGN.md itself says to watch two weeks of real usage first -- "in a
two-cook kitchen, a server walking five steps and calling out may well be
faster". Ship the smallest thing; talk about shared state once it is being used.

### Measurements

| | |
|---|---|
| Kitchen logs one refill | observed_at = the moment recorded, attributed to kitchen |
| "Empty" backdated 15 minutes | observed_at is exactly 15 minutes earlier |
| Sent after two hours offline | Lands **two hours ago**, not at arrival |
| The same op replayed | duplicate, not stored twice |
| Four malformed payloads | All rejected, each with a readable reason |
| A front account logging a refill | Accepted (front and kitchen can both log) |
| Two tables ordered from another front device | Two cards in the kitchen, with add-ons and hand-typed requests |
| Marking every dish on a ticket done | The whole card disappears |

---

## Template

```
## YYYY-MM-DD -- Step N, topic

**Decision:**
- chosen / rejected / why / what it costs

**Measurement:**
- metric: before -> after

**Failure:**
- symptom / wrong assumption / how it was found / root cause
```
