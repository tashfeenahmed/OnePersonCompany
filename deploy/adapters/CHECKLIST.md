# Per-product mapping checklist

Work through this once per product. It is in this order because each step makes
the next one answerable, and because the two steps people skip — 3 and 6 — are
the two that produce a document that is perfectly valid and quietly wrong.

Keep the answers. A filled-in copy of this file beside the mapping is what makes
the mapping readable in a year.

---

## 1. Which contract does this product owe

- [ ] **users** — the product has its own account table. Almost every product does.
- [ ] **product-stats** — the product knows a number about itself that no vendor
      can be asked for: reels rendered, applications indexed, chats answered.

Most products owe both, and they are two accounts on the dashboard, not one.

**If it is only product-stats, stop here.** Point a product-stats account at any
URL the product already answers JSON on, and write the mapping lines
(`label = path.to.number`) in that plugin's settings. That resolves on every
read, so editing it needs no deploy on the product's host. No adapter.

---

## 2. Can the product name its users, or only count them

- [ ] **Name them** → the `users` form. One object per person.
- [ ] **Only count them** → the `counts` form:
      `{"counts": {"total": 158, "new": {"days": 7, "n": 12}}}`

`{"users": []}` says *this product has no users*. `{"counts": {"total": 158}}`
says *it has 158 and cannot name them*. Those are opposite facts. Use the second
one for a product whose users live in a third party, behind an admin API that
only publishes aggregates, or in a database this host cannot reach.

Answer: ______________________________________________

---

## 3. What does "user" mean in THIS product

This is the step that decides whether the portfolio total means anything.

Write down, in the product's own words, who is in the user table:

> ______________________________________________________________

Then map each of them onto one of the five:

| Population | Means | This product's value(s) |
|---|---|---|
| `customer` | signed up for this product on their own behalf | |
| `participant` | present because somebody else invited them | |
| `admin` | operates the product | |
| `trial` | signed up, has not paid, and the product tracks the difference | |
| `internal` | the owner's own accounts, test rows, seed data | |

Questions that usually find the answer:

- [ ] Is there a role, plan, type or `is_staff` column? Name it: ____________
- [ ] Does the table hold people who were **invited into somebody else's
      session** and never had an account of their own? Those are
      `participant`, and counting them as customers is the single most common
      way a portfolio total becomes fiction. (A two-sided product typically has
      ten to twenty times more of them than customers.)
- [ ] Does it hold **only** operator logins — one or two rows — because the real
      customers are Stripe subscribers? Then this product's users are `admin`,
      and the customer count comes from the Stripe plugin. Say so in the note
      rather than publishing two admins as the user base.
- [ ] Are the owner's own test accounts in there? Those are `internal`.
- [ ] Is this a CMS table — WordPress `wp_users`, say — whose rows are **authors,
      not customers**? Those are `admin`, and the product's real customers are
      somewhere else entirely.

**Every value that is not in your map falls to `population.default` and is
counted and reported by `--check`.** Run it and look at the unmapped list before
you believe the breakdown.

---

## 4. What identifies a person, and when did they arrive

- [ ] `id` — the product's own id, stable forever. Not the row number, not the
      email. It is what makes the same person one row across collections.
- [ ] `createdAt` — ISO 8601. Where the column is a unix number, the adapter
      decides seconds vs milliseconds by magnitude; where it is a local-time
      string with no zone, **fix that in the query** rather than hoping.
- [ ] Is there a soft-delete or ban column? Add it to the `WHERE` — a banned
      account is not a signup that reversed itself, but it is not a live user.
      Write down which you chose: ____________________
- [ ] Optional and worth having where they exist: `email`, `plan`, `paid`,
      `lastSeenAt`, `country`.

`paid` is `true`, `false`, or **left out entirely**. A product that cannot say
has an unknown paid count, never a zero one.

---

## 5. Deployments are not summed

If the same product runs in more than one place — a cloud instance and a
self-hosted one, a demo box and production — they are **separate endpoints with
separate labels**, never one query with a `UNION`. Different databases holding
different people; adding them invents users who do not exist.

Endpoints for this product: ______________________________________

---

## 6. Consent — only fill this in if it is true

Leave `contact_mapping` out entirely and every row is `contactPermitted: false`.
That is the default and it is the right answer for most products.

Fill it in only when the product has a column that records **a person agreeing
to be written to**:

- [ ] Column: ____________________
- [ ] Values that mean yes: ____________________
- [ ] `consent_note` — one sentence saying where in the product they agreed:

> ______________________________________________________________

The adapter refuses to run a `contact_mapping` with no note, on purpose. An
adapter that claims consent and cannot say where it came from is the thing this
field exists to prevent.

Things that are **not** consent: having an address; having paid; not having
unsubscribed; a `marketing` column that was defaulted to true at migration.

---

## 7. Wire it

- [ ] Copy `sql-adapter.mjs`, `http-adapter.mjs` and `lib/` to the product host.
- [ ] Write the mapping from the nearest `examples/` file.
- [ ] Secrets as `${ENV_VAR}`, in a mode-600 environment file, never in the mapping.
- [ ] The database password is in `source.password` (passed through the child's
      environment), or in `~/.pgpass` / `PGSERVICE` — **not inside `source.dsn`**,
      which becomes an argv element visible in `ps` on this box and, over ssh, on
      the remote one too.
- [ ] `node sql-adapter.mjs mapping.yaml --check` — read every line it prints.
- [ ] Unmapped populations: are they really the default? ____________________
- [ ] Cron with the check in front of the write, or the systemd unit for the
      HTTP form. See README.md.

### Where the file may go — do not skip this one

The document contains **every customer's raw email address**. The dashboard
hashes them on arrival; the file on this host does not.

- [ ] It is `0640` (the adapter writes it that way) and owned by the cron user.
- [ ] It is **not** in a directory the web server publishes unauthenticated.
      A static file cannot check a bearer token; the dashboard is willing to
      send one. Pick one and write down which:
      - [ ] behind the same auth as the product's own admin API
            (nginx `auth_request` / basic auth / an allow-list on the
            dashboard's address) — **preferred**
      - [ ] not served over HTTP at all; the dashboard reads it another way
      - [ ] `http-adapter.mjs` instead, which requires a token by construction
      - [ ] an unguessable path under an existing web root — **weakest**, and
            only where the other three genuinely do not fit
- [ ] Fetch it from a machine that should NOT be able to see it and confirm you
      get a 401/403/404 rather than the list.
- [ ] The cron passes `--out`. Without it the whole document goes to stdout and
      cron mails it.
- [ ] Add the account on the dashboard: Integrations → Product users (or Product
      endpoints), label = the product's name.
- [ ] Validate the real payload against the dashboard's own validator and check
      it lands under Settings → Migration:

```
curl -sS -X POST http://127.0.0.1:8787/api/migrate/adapters/validate \
  -H 'content-type: application/json' \
  -d "{\"endpoint\":\"<label>\",\"payload\":$(cat users.json)}"
```

- [ ] Press Collect on the plugin page and confirm the row count matches.

---

## 8. Write down what it cannot say

Every product has something it does not know, and the sentence is worth more
than the mapping. Examples: *"this counts accounts, and a household shares one"*;
*"`lastSeenAt` is set by the mobile app only, so web-only users look dormant"*;
*"deleted rows are hard-deleted nightly, so the total only ever goes up between
midnights"*.

> ______________________________________________________________

Paste it into the endpoint's account description on the dashboard. It is the
part nobody can reconstruct later.
