# Contributing to One Person Company

Thanks for helping make this useful for people running their own businesses.
Good contributions make a workflow clearer, add a reliable data source, fix a
reproducible bug, or improve the documentation.

## Start with a small, concrete change

For a substantial feature or architectural change, open an issue describing the
user's problem and the result you want. For a focused bug fix or documentation
improvement, a pull request is welcome directly.

Fork the repository, make your change in your fork, and open a pull request
against `main`. `main` is the project's maintained branch.

## Run locally

Use Node.js `>=24.18 <27` and npm. The exact CI version is in `.node-version`.

```sh
npm run setup
npm run dev
```

Run `npm run check` before submitting a code change. It covers the test suites,
build, lint, widget catalog, and strict type checks. Tests use isolated storage;
never point a test run at your working data directory. For documentation-only
changes, check the links, commands, and rendered images you changed.

## Keep the product trustworthy

- Preserve saved dashboards, checklist progress, and other owner decisions.
- Keep source adapters separate from reusable calculations and UI components.
- Treat missing or unavailable data as unknown, not zero.
- Keep currencies and incompatible measurements separate.
- Give stored entities stable IDs; do not rename persisted keys casually.
- Use fictional fixtures, reserved example domains, and synthetic screenshots.
- Keep credentials, `.env` files, databases, backups, private host inventories,
  personal addresses, and customer data out of commits.
- Describe material limitations and cover changed behavior with appropriate tests.

The [shared-module guide](docs/shared-modules.md),
[venture journey contract](docs/venture-journeys.md), and
[metrics contract](docs/workspace-insights.md) describe useful extension points.

## Make the pull request easy to review

Explain the problem, the resulting behavior, and how you verified the change.
For UI changes, include images made with fictional data. Mention migration,
configuration, or compatibility impacts when they apply. Keep unrelated changes
separate.

For suspected vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of
posting exploit details publicly.

Contributions are submitted under this repository's [MIT license](LICENSE).
