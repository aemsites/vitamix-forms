# CLAUDE.md — vitamix-forms

## Branching & releases

Merge order: **feature branch → `stage` → `main`**, which release to the
**stage** and **prod** environments respectively.

- **Base feature branches on `stage`, and open PRs against `stage`.** This is the
  default target for all normal work.
- **`stage` → `main` PRs are opened manually** (to promote stage to prod). Do not
  open a PR against `main` for feature work.
- Pushes deploy automatically: `stage` → stage, `main` → prod via semantic-release
  (only when a `feat`/`fix` commit cuts a release). To redeploy without a code
  change (e.g. after changing a secret), run the **Stage** or **Production**
  workflow manually (`workflow_dispatch`); it only runs from `stage` / `main`.

## Testing

- Run tests with `npm test` (Jest under `NODE_OPTIONS='--experimental-vm-modules'`).
- Lint with `npm run lint`.
