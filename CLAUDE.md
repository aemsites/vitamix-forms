# CLAUDE.md — vitamix-forms

## Branching & releases

Merge order: **feature branch → `stage` → `main`**, which release to the
**stage** and **prod** environments respectively.

- **Base feature branches on `stage`, and open PRs against `stage`.** This is the
  default target for all normal work.
- **`stage` → `main` PRs are opened manually** (to promote stage to prod). Do not
  open a PR against `main` for feature work.

## Testing

- Run tests with `npm test` (Jest under `NODE_OPTIONS='--experimental-vm-modules'`).
- Lint with `npm run lint`.
