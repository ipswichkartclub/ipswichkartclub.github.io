# Driver Briefing Check-in

Kart race meeting driver-briefing check-in. Drivers scan a QR code, pick their
class, find themselves by kart number or name, and tap once. Anyone already
checked in drops off the list, so it only ever shows who is still outstanding —
and the class dropdown counts down as the briefing fills up. Officials get a
live list of everyone who has **not** checked in.

- **Front end** — static HTML/JS, hosted on GitHub Pages (`/docs`)
- **Back end** — one Cloudflare Worker + a D1 (SQLite) database

## Concurrent check-ins

Every driver's phone talks to the same D1 database, so a whole grid can check in
simultaneously and the admin page sees it within 15 seconds.

- **A driver can never be checked in twice.** `UNIQUE (event_id, person_id)` is
  enforced by the database, not by application logic. If two phones submit the
  same driver in the same instant, one insert wins and the other is caught and
  reported as *already checked in* — there is no window where both succeed.
- **No shared mutable state in the Worker.** Each request is independent, so
  Cloudflare can run as many in parallel as it likes.
- **Reads are cheap.** A check-in is a handful of indexed lookups plus one
  insert; the roster the page loads is a single indexed query.

Sizing for a 250-driver meeting on the **free** tier, which is what this is
built for:

| | Free tier allows | A 250-driver meeting uses |
|---|---|---|
| Worker requests | 100,000 / day | ~1,500 |
| D1 rows written | 100,000 / day | ~750 |
| D1 rows read | 5,000,000 / day | ~100,000 |
| D1 storage | 5 GB | well under 1 MB |

The one endpoint that does heavy work is creating a meeting (~500 inserts).
Because a free-tier Worker is capped at 10 ms CPU per request, the admin page
**uploads the entry list in 50-row chunks** (`POST /api/admin/events/:id/rows`)
rather than one large request, showing progress as it goes. Each chunk is a
small, fast call, and a driver whose classes land in different chunks still
collapses to a single person.

## How it works

### One check-in per person, not per entry

A driver can be entered in more than one class. The entry list is collapsed into
*people* (keyed on **CRN**, falling back to a normalised name when CRN is
missing) and *entries* (one per spreadsheet row). Checking in once satisfies
every class that person is entered in.

In the sample 2026 IROC list that is 247 entries → 240 people, with 7 drivers
doubling up (for example KA3 Senior #57 and X30 #1 are the same person).

### Junior vs adult

The **Guardian** column decides this:

| Guardian value | Treated as |
|---|---|
| `Not Applicable` | Adult |
| anything else | Junior (has a guardian) |

### Briefing acknowledgement

Before the check-in button becomes active, the driver must tick:

> I confirm that I have read and understood the driver briefing notes for this
> meeting, and agree to comply with them.

Reword it via `ackText` in `docs/assets/config.js`. Three things make this a
record rather than decoration:

- **The API enforces it.** A check-in without `acknowledged: true` is rejected
  with a 400, so the checkbox can't be bypassed from the console.
- **The exact wording is stored** against each check-in, so if you reword it
  later, older records still show what was actually agreed to.
- **It is per driver, not per phone.** A guardian checking in two children ticks
  it once for each.

When an official checks someone in manually, they get a confirmation prompt and
the record is stored as acknowledged with the wording *"Acknowledgement confirmed
by an official"* and a `source` of `admin`, so the two cases stay distinguishable.

The CSV export carries **Checked in by**, **Briefing acknowledged** and
**Acknowledgement wording** columns.

### Device limits

Check-in is de-duplicated per device (a random token in `localStorage`), with
separate budgets so a racing parent can do their kids *and* themselves:

| | Per device |
|---|---|
| Adults (`Not Applicable`) | 1 |
| Juniors (guardian named) | 4 |

Change the numbers with the `DEVICE_LIMIT_ADULT` / `DEVICE_LIMIT_JUNIOR` vars in
`wrangler.toml`. These are only a backstop — see **One device, one person**
below for the rule that actually governs who may check in whom.

### One device, one person

The first check-in on a device **binds that device to a single person**, and
everything checked in afterwards must resolve to that same person:

- an **adult** binds the device to *themselves*
- a **junior** binds it to *their guardian*

That covers all three orderings:

| First on the device | Then | Result |
|---|---|---|
| checked in as a driver | a minor they are **not** the guardian of | **rejected** |
| checked in as a driver | a minor they **are** the guardian of | allowed |
| a minor | a sibling with the same guardian | allowed |
| a minor | a minor with a different guardian | **rejected** |
| a minor | themselves as a driver, **being** that guardian | allowed |
| a minor | themselves as a driver, **not** that guardian | **rejected** |

Identity is matched on the **member number in brackets** first, falling back to
the name — so a racing parent is recognised as the guardian because the CRN in
their child's Guardian column is their own CRN. A match needs only one identity
in common, which handles the shapes that actually appear in an entry list:
siblings listing the same two parents in a different order, or one child listing
both parents while another lists only one.

Anyone rejected is told to **see an official at the driver briefing**, who can
check them in manually from the admin page. No guardian names are ever shown on
the rejection screen or returned by the API.

There is still a backstop cap per device (1 adult, 4 juniors) purely to bound
abuse, but the identity rule is the real control. The junior cap has to clear
the largest family actually racing — the 2026 IROC list contains two guardians
with **three** children entered, so a cap of 2 would have turned real families
away.

Independently of the device rule, **a person can never be checked in twice** —
tapping the same driver from any device shows the already-checked-in page. That
is what keeps the register correct.

The client IP is recorded against each check-in and shown in the admin view, but
it is **not** used to block anyone: at a track most phones share the club WiFi or
carrier CGNAT address, so IP blocking would lock out everyone after the first
person. If someone genuinely can't check in from their phone, an official checks
them in manually from the admin page.

## Deploy

### 1. Back end (Cloudflare, free tier)

```bash
cd worker
npm install
npx wrangler login

npm run db:create          # prints a database_id
```

Paste that `database_id` into `wrangler.toml`, then:

```bash
npm run db:init            # create the tables
npm run secret             # set ADMIN_KEY - paste a long random string
npm run deploy             # prints https://ikc-checkin-api.<subdomain>.workers.dev
```

> `db:init` drops and recreates the tables. On a database that already holds
> real check-ins, apply changes by hand instead — for example
> `wrangler d1 execute ikc-checkin --remote --command "ALTER TABLE checkins ADD COLUMN acknowledged INTEGER NOT NULL DEFAULT 0"`.

Keep the `ADMIN_KEY` somewhere safe: it is the only thing protecting the admin
page and the entrant contact details.

### 2. Front end (GitHub Pages)

Edit `docs/assets/config.js` and set `apiBase` to the Worker URL printed above.

```bash
git init
git add .
git commit -m "Driver briefing check-in"
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

Then in the repo: **Settings → Pages → Source: Deploy from a branch →
`main` / `/docs`**.

The site appears at `https://<you>.github.io/<repo>/`.

### 3. Lock down CORS (recommended)

Once you know the Pages URL, set it in `wrangler.toml` and redeploy:

```toml
ALLOWED_ORIGINS = "https://<you>.github.io"
```

## Running a meeting

1. Open `admin.html`, sign in with the admin key.
2. **New race meeting** — name it, set the date, upload the entry list
   (`.xlsx`/`.csv`). A preview shows people, entries, classes and any warnings
   (drivers in multiple classes, missing CRNs) before you commit.
3. **Create event** — you get a unique 6-character event id and a QR code.
   *Print poster* gives you an A4 sheet to put up at the briefing.
4. During the briefing, watch **Not checked in**. It refreshes itself every 15
   seconds — no page reload — and *Refresh now* forces an immediate update.
   Switching tabs also pulls fresh data. Untick *Auto-refresh* to stop polling;
   the choice is remembered.
5. **Check in** next to a name marks someone off manually (for a flat phone, or
   somebody who hit the device limit). It is tagged *by official*.
6. **Close check-in** when the briefing ends; the public page then refuses
   further check-ins.

The **By class** tab prints a per-class marshalling sheet. Each class collapses —
click its heading, or use *Expand all* / *Collapse all* / *Collapse completed*,
which folds away the classes that are fully checked in so only the ones still
missing people stay open. A collapsed class still prints in full. **Export CSV**
dumps whichever tab you are on.

### Spreadsheet columns

Required: **Kart No**, **Entrant**, **Class**.
Used when present: **Guardian** (junior/adult), **CRN** (person identity),
Transponder Number, Kart, Engine, Email, Mobile, Member Type, Home Club.

Header matching is case- and punctuation-insensitive, and the header row is
found automatically within the first 15 rows.

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/events/:id` | — | Roster for the check-in page |
| `POST` | `/api/checkin` | — | `{eventId, personId, deviceId}` |
| `GET` | `/api/admin/events` | key | List meetings with counts |
| `POST` | `/api/admin/events` | key | Create a meeting (`rows` optional) |
| `POST` | `/api/admin/events/:id/rows` | key | Append a chunk of the entry list |
| `GET` | `/api/admin/events/:id` | key | People, entries, check-in status |
| `PATCH` | `/api/admin/events/:id` | key | Rename / re-date / open / close |
| `DELETE` | `/api/admin/events/:id` | key | Delete meeting and its check-ins |
| `POST` | `/api/admin/events/:id/checkin` | key | Manual check-in |
| `DELETE` | `/api/admin/events/:id/checkin/:personId` | key | Undo |

Admin requests send `Authorization: Bearer <ADMIN_KEY>`.

## Tests

```bash
cd worker
npm test
```

56 assertions covering auth, spreadsheet collapsing, the multi-class rule, both
device budgets, admin views, manual check-in/undo, close/reopen and delete. It
runs the real Worker code against an in-memory SQLite D1 shim — no deploy and no
network needed. The fixture is generated, so no member data lives in this repo.

## Privacy

The entry list holds names, emails, phone numbers and guardian details for
minors.

- Real entry lists are git-ignored (`*.xlsx`, `*.csv`) — never commit one.
- The check-in page is unauthenticated, so it is served the bare minimum: kart
  number, entrant name, class and a junior flag. **Guardian names, CRNs, emails
  and phone numbers are never sent to it**, in any response, including error
  responses — otherwise anyone holding a phone could pick a child off the list
  and learn their guardian's name from the rejection message. The guardian
  matching rule runs entirely server-side.
- Contact details are only ever returned behind the admin key.
- Delete a meeting after the event to clear its data.
