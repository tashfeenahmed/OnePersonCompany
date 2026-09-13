# Local inventory

Keep owner-specific inventory in the configured `OPC_DATA_DIR` (by default
`server/data`), beside the local database. This directory is ignored by Git.
Examples, tests, and widget previews in the repository use synthetic data.

For server flags outside known provider regions, create `fleet-regions.json`:

```json
[
  {
    "address": "192.0.2.10",
    "hostname": "example-server",
    "location": "Example region",
    "country": "US"
  }
]
```

Both address and hostname must match the collected server. Country is a
two-letter uppercase code. Provider region metadata takes precedence.
This file is reread when the fleet endpoint is requested.

For SSH user probes, create `users-box-sources.json`:

```json
[
  {
    "id": "example-app",
    "product": "Example App",
    "site": "app.example.test",
    "box": "Example server",
    "idField": "fields.id",
    "cannot": ["Payment state is not reported by this probe."]
  }
]
```

The id must match the remote probe's source id. Optional fields map plans,
payment states, last-seen timestamps, and populations; `BoxSource` documents
their schema. Restart the server after changing source mappings. Missing files
mean no local mappings. Invalid JSON or invalid entries produce an error that
names the configuration file without including its contents. Keep these files
with your private operational backups; they contain no credentials.
