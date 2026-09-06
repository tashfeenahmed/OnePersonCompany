# Product adapters

An adapter is a small program that runs **on the product's own host** and
publishes what OnePersonCompany asks a product for. Nothing here is installed on
the dashboard's machine, and nothing here has a dependency: the files are copied
to a box with `scp` and run with the Node that is already there.

There are two contracts and they are asked for different reasons.

| Contract | What it publishes | Where the shape is defined |
|---|---|---|
| **users** | who signed up, when, and which population they belong to | `server/src/integrations/activity/users.ts` |
| **product-stats** | whatever numbers the product knows about itself | `server/src/integrations/ops/products.ts` |

**Only the users contract needs an adapter.** The stats contract is *any JSON
object* — which numbers in it matter is a mapping the dashboard holds and
resolves on every read — so a product that already answers JSON anywhere needs
a product-stats account pointed at that URL and two lines of settings, not code.

## The files

```
sql-adapter.mjs      run a SELECT on a cron, write the users document to a file
http-adapter.mjs     serve the same document live behind a bearer token
lib/config.mjs       the mapping file reader (a small YAML subset, or JSON)
lib/contract.mjs     the contract, checked locally so mistakes fail fast
lib/build.mjs        drivers (postgres, mysql, sqlite, command) and the mapping
CHECKLIST.md         what to work through per product, in order
examples/            one worked mapping per shape of source
```

## Which one

**`sql-adapter.mjs`** where the user list changes slowly and there is somewhere
safe to put a file. It costs nothing between cron ticks and it survives the
process dying. Put the check in front of the write so a schema change stops the
file updating rather than replacing it with an error:

```
*/20 * * * * cd /opt/opc-adapter && node sql-adapter.mjs mapping.yaml --check --quiet \
             && node sql-adapter.mjs mapping.yaml --quiet
```

> **The file it writes is every customer's raw email address.** The dashboard
> hashes addresses on arrival; this file, on the product's disk, does not. It is
> written `0640` — but the mode is the easy half. **Do not put it in a directory
> your web server publishes unauthenticated.** A static file cannot check the
> bearer token the dashboard is perfectly willing to send, so it goes behind the
> same auth as the admin API it is replacing (a `require_auth` location, basic
> auth, an allow-list on the dashboard's address), or it is not served over HTTP
> at all and the dashboard reads it another way. "Under a long random path" is
> the weakest answer that is still an answer. If none of that is convenient, use
> the HTTP adapter below — it requires a token on every request by construction.
>
> With no `--out` the document goes to **stdout**, which under the cron above
> becomes a mail full of addresses. Pass `--out`.

**`http-adapter.mjs`** where there is no web root to write into, where the
number has to be current at the moment it is asked for, or where the answer must
be behind a token. Bind it to `127.0.0.1` and put it behind the reverse proxy
that already terminates TLS for the product.

```ini
# /etc/systemd/system/opc-adapter.service
[Service]
WorkingDirectory=/opt/opc-adapter
EnvironmentFile=/etc/opc-adapter.env     # OPC_ADAPTER_TOKEN=…, DSNs
ExecStart=/usr/bin/node http-adapter.mjs mapping.yaml --port 8791
Restart=always
```

Both read the same mapping file, so switching costs nothing.

## Start here, every time

```
node sql-adapter.mjs examples/<nearest>.yaml --check
```

`--check` runs the query with a row limit, builds the document, validates it,
prints every problem and every note, and **writes nothing**. `--check FILE`
validates a sample payload with no database at all, which is what to run on a
laptop against a payload somebody pasted from production.

Then confirm it against the dashboard's own validator, which is the
authoritative one — `lib/contract.mjs` is a deliberate second copy that exists
only to fail fast on the product's host:

```
curl -sS -X POST http://127.0.0.1:8787/api/migrate/adapters/validate \
  -H 'content-type: application/json' \
  -d "{\"endpoint\":\"Example App 1\",\"payload\":$(cat users.json)}" | jq
```

The result lands under **Settings → Migration**, beside every other endpoint.

## The two fields that are new, and easy to get wrong

`population` is one of `customer`, `participant`, `admin`, `trial`, `internal`.
**Leaving it out means `customer`**, which keeps every endpoint written against
the older contract valid and meaning the same thing — and also means a product
with participants that does not classify them is over-reporting customers
without any error appearing anywhere. `--check` prints the breakdown; look at it.

`contactPermitted` is `false` unless the document says the literal `true`, and
the adapter will only ever emit `true` where a `contact_mapping` block names the
column recording consent **and** carries a `consent_note` saying where in the
product a person agreed. There is no inference and there is deliberately no way
to add one. The dashboard stores it beside a salted hash of the address and has
no route that returns an address: the count exists so a recovery campaign can be
*sized* before anyone decides to run it, and the sending is done from the product
that holds the consent.

## The mapping file

JSON is read as JSON. `.yaml` is read as a **deliberate subset** — two-space
nesting, `key: value`, `|` block scalars for SQL, and single-line flow lists
like `[1, "t", yes]`. No anchors, no flow mappings, no multi-document files.
Anything it cannot read is an error naming the line. If the subset annoys you,
write JSON.

Secrets go in as `${ENV_VAR}` and come from the environment; an unset variable
is a refusal naming it, because an adapter that connected with an empty password
produces an auth error somebody spends an hour on. Keep the environment file
mode `600`.

**A password inside a DSN still ends up in `ps`.** `psql` and `mysql` take their
connection string as an argument, and over `ssh` it is part of the remote command
line as well — visible to any other user on either box for the length of the
query. The adapter avoids this where the client lets it: give `source.dsn` with
**no password in it** and put the password in `source.password` instead, and it
is passed to the child through `PGPASSWORD` / `MYSQL_PWD` (and forwarded to the
remote as an environment assignment rather than an argument). Better still on
Postgres, put the whole thing in a `~/.pgpass` (mode 600) or a `PGSERVICE` entry
on the box that runs the query and give a DSN that names neither user nor
password.

See `examples/` for a worked mapping of each shape, and `CHECKLIST.md` for the
order to do it in.
