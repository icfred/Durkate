# @durak/assets

## Purpose

Generated pixel-art assets and a typed index for the web app. Outputs of
the Python pipeline in `tools/` land here as PNG sprite sheets, JSON
atlases, and a TS index that exports typed asset paths.

## Key concepts

- **Sprite sheet**: a packed PNG containing multiple sprites.
- **Atlas**: a JSON descriptor mapping sprite names to rectangles in the
  sheet. Pixi-native format.
- **Generated index** (`src/generated/`): output of the Python pipeline.
  Committed to git so consumers don't need Python to build.

## Public API

- `cards` - typed map of card sprite paths.
- `ui` - typed map of UI sprite paths.
- `loadAll(app)` - register every sprite sheet with Pixi's loader.

## Invariants

- The contents of `src/generated/` are produced by `tools/`. Never
  hand-edit. `pnpm assets:check` verifies the directory is current.
- Every sprite reference in `apps/web` goes through this package's typed
  index, never via raw paths.

## Gotchas

- Asset outputs are committed. CI does not run the Python pipeline. If you
  add or change a sprite, run `pnpm assets:build` locally and commit the
  diff.

## Related ADRs

- (none specific - asset pipeline is described in `tools/README.md`)
