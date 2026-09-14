# Onboarding and automatic setup

A fresh database opens a seven-step setup: Workspace, Venture, Services, Connect, Organise, Assistant, and Ready. Planning works without connected services or an assistant. Existing workspaces bypass setup; it does not replace their dashboards.

The welcome introduces five essentials, including the automatically provisioned sub-agents. Workspace setup asks for a name, workspace name, and password individually, with inline validation and Back/Enter navigation. The browser supplies the timezone automatically, with UTC as a fallback. The account is created only after all three answers pass validation.

Ventures can select several business types. Setup, venture editing, checklists, operating reviews, and automatic widget matching retain all selections. Existing single-type ventures keep their saved choice. The legacy `businessType` API field remains available; `businessTypes` stores the full selection.

All available services appear immediately, with search and category filters and locally bundled brand-colored app tiles. Back and Continue stay in a fixed bottom navigation bar while the setup screen scrolls above them.

Welcome items reveal in a short stagger. Screen changes use a 130ms fade out and 210ms fade in through the browser's animation API, with no animation library or continuing render loop. Reduced-motion preferences skip these animations. The interactive office is loaded only on the welcome screen and disposed when setup begins.

## Connections

Select the services you use, then download the generated `connections.env` template. Its values start empty. Paste the completed file, upload it, or use individual fields. JSON service-account files and multiline private keys are supported. Additional accounts receive numbered ENV names such as `LOCAL_MODEL_BASE_URL__2`.

Each account is verified through its existing integration adapter before its credentials are written to the encrypted server vault. The first collection runs during setup. Missing credentials, rejected access, and incomplete collections are shown separately. Retrying a saved account reuses its stored credentials and account ID.

ENV text and passwords are never saved in the setup draft or browser storage. Unsubmitted credentials disappear on reload; saved preferences and successful connections remain. Keep any ENV file you download or edit private and outside version control.

## Shared services and venture data

Connections belong to the workspace. A declarative capability map selects the initial dashboards from successfully connected services. OpenAI and OpenRouter can be used with an inference key alone; reporting dashboards require their separate reporting credentials.

Automatic resource discovery runs after completion and once a minute while the app is running. It also covers ventures and connections added later. A unique, exact website match can link a resource to a venture. Ambiguous matches, guessed bundle domains, and resources without a matching website stay unassigned; use the venture's Connections page to link them manually.

Venture dashboards require a matching resource, a compatible business type, and widgets that support venture-specific data. Account-wide figures such as Stripe totals remain on workspace dashboards. Every venture gets its existing stage- and type-specific checklist. Automatic setup adds a matching venture dashboard once and never rewrites a customized dashboard or restores one the owner removed. Removed automatic resource links are likewise respected.

## Assistants

Choose Hermes or OpenClaw and a connected LLM provider. Install and start a managed agent in the flow, or connect an existing agent endpoint. Managed agents use the selected provider. Existing remote agents retain their own model configuration. If runtime setup is postponed, the app can chat directly through the chosen LLM provider and clearly labels the agent setup as pending.

## Test with another database and port

Run this from the repository root while your usual instance stays running:

```sh
setup_test_dir=$(mktemp -d)
touch "$setup_test_dir/empty.env"
OPC_DATA_DIR="$setup_test_dir/data" \
OPC_ENV_FILE="$setup_test_dir/empty.env" \
OPC_COLLECT_MINUTES=0 PORT=8791 OPC_UI_PORT=5191 npm run dev
```

Open `http://127.0.0.1:5191`. Use an unused UI/API port pair if those ports are occupied. The empty ENV file prevents the test instance from loading credentials from your normal server ENV file; its database and vault are in the temporary directory. Explicit connection checks still run, but periodic provider collection is disabled. Browser login cookies are shared across ports on the same hostname, so use a separate browser profile if the normal instance also uses `127.0.0.1`.

## Extending setup

- `shared/onboarding.ts` validates the saved draft and handles ENV names and parsing.
- `shared/onboardingPlan.ts` maps services to capabilities, widgets, and compatible venture types.
- `server/src/routes/plugins.ts` supplies the existing credential schemas, verification, vault writes, and collection.
- `server/src/onboarding/` handles completion and resource reconciliation.
- `client/src/pages/Onboarding.tsx` renders the setup flow using the app's integration catalog and venture checklists.

Run `npm run check` for tests, type checks, the production build, lint, and catalog validation.
