# Contributing

Thanks for helping. Bug reports, app interop reports, docs fixes and code are all welcome.

For **security vulnerabilities**, don't open an issue: see [SECURITY.md](SECURITY.md).

## Ways to help without writing code

- **Tell us an app works (or doesn't).** Open an issue with the app, the target settings you used (never a token) and what happened. A "works with X" report is as valuable as a bug report: it becomes a profile or a line under [Apps](README.md#apps).
- **Improve the docs.** If something in the [README](README.md) was unclear or wrong for you, it will be for others.

## Setup

You need Node 24 and pnpm 10 (`corepack enable` gives you the pinned version).

```sh
git clone https://github.com/mmcintosh/better-auth-scim-provisioning.git
cd better-auth-scim-provisioning
pnpm install
pnpm test
```

## Checks

Everything CI runs, locally:

| Command | What it does |
|---|---|
| `pnpm typecheck` | TypeScript (`strict`). |
| `pnpm lint` | Biome; warnings fail. |
| `pnpm test` | Unit and integration tests on SQLite, against a mock SCIM app, a mock Google Directory API and webhook receivers, plus the regression tests. |
| `pnpm pack:check` | Builds, then checks the package under TypeScript 5.9 and 7 with a strict host, publint and Are the Types Wrong. |

Two suites need something extra:

- **Adapter matrix**, against a real database: start one, then point the tests at it, for example:

  ```sh
  docker run -d --rm -p 55432:5432 -e POSTGRES_PASSWORD=test postgres:17-alpine
  ADAPTER_DB=postgres ADAPTER_URL=postgres://postgres:test@localhost:55432/postgres npx vitest run test/adapters
  ```

  `ADAPTER_DB` is `postgres`, `mysql`, `mongodb`, `drizzle-postgres`, `drizzle-mysql`, `prisma-postgres` or `d1`. MongoDB must be a replica set: see the `adapters` job in [ci.yml](.github/workflows/ci.yml).
- **Live tests** (`test/live/`) run against real services (Cloudflare Access, Google Workspace, AWS IAM Identity Center) when the git-ignored `.env.live` holds their settings: `npx vitest run -c vitest.live.config.ts`. Each file runs only with its settings and cleans up after itself. They aren't run in CI.

## How changes are made here

- **Tests with every change.** A bug fix comes with the test that would have caught it; regressions live in `test/regressions/`.
- **Security checks are mutation-checked.** For a check that refuses something (URL rules, credential binding, adoption rules), disable it and confirm a test fails, then put it back. Say in the PR that you did it.
- **Say why in the pull request.** A design choice, an interop finding or a security trade-off is explained in the PR description: what was found, what was decided, and the evidence.
- **Docs move with the code.** A new option, behaviour or limit goes in the [README](README.md), and a line under `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md).
- **Breaking?** Check [versioning](docs/versioning.md). What an app receives counts too.
- **No real secrets, ever.** Tests use mock services and throwaway credentials; live-test settings stay in the git-ignored `.env.live`. gitleaks runs on every push.
- **Commits:** small, with an imperative subject and a body that says why.

## Pull requests

1. Fork the repository and branch from `main`.
2. Make the change with its tests and docs.
3. Run `pnpm typecheck && pnpm lint && pnpm test && pnpm pack:check`.
4. Open the pull request.

CI runs the full matrix (Better Auth at the peer range's minimum and the latest 1.7, Node 22 and 24, the adapter matrix, Workers runtimes, the example), CodeQL, dependency audits and dependency review. A new **runtime** dependency needs a good reason: every one is attack surface for a plugin that holds credentials to your apps, and it must be MIT-compatible.

## Releasing (maintainers)

See [Development](README.md#development) in the README: `pnpm release patch|minor|major` opens the release pull request, and merging it starts the release, which waits for the maintainer's approvals. Before opening it, check that the README covers everything in `[Unreleased]`.
