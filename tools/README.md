# tools

## Purpose

Python asset pipeline for Durak. Source art lands in `tools/`, runs
through four stages, and emits committed PNG sprite sheets, JSON
atlases, and a typed TS index under `packages/assets/src/generated/`.
CI does not run this pipeline. Outputs are committed.

## Stages

| Module | Role |
|---|---|
| `durak_tools.scraper` | Pull source art into a staging area |
| `durak_tools.converter` | Normalize to canonical PNGs |
| `durak_tools.packer` | Pack sprites into sheets + atlases |
| `durak_tools.index_emitter` | Emit `packages/assets/src/generated/` |

All four are stubs in this scaffold. Real logic lands in follow-up
tickets.

## Layout

```
tools/
├── pyproject.toml             # uv project, Pillow dep
├── uv.lock                    # committed
└── src/durak_tools/
    ├── __init__.py
    ├── __main__.py            # build / check entry points
    ├── scraper.py
    ├── converter.py
    ├── packer.py
    └── index_emitter.py
```

## Commands

| Command | What it does |
|---|---|
| `pnpm assets:build` | `uv run --directory tools build` - run all four stages |
| `pnpm assets:check` | `uv run --directory tools check` - verify generated outputs are current |
| `uv run --directory tools python -m durak_tools build` | Same as `assets:build`, without console-script entry |

`build` and `check` are declared in `pyproject.toml` under
`[project.scripts]` and resolved by `uv run`.

## Requirements

- Python 3.12+
- `uv` (https://docs.astral.sh/uv/)

`uv run` creates `.venv/` on first run and installs the project in
editable mode. Both are gitignored.

## Invariants

- `uv.lock` is committed. Re-run `uv lock --directory tools` after
  dependency changes.
- Generated outputs under `packages/assets/src/generated/` are
  committed. `pnpm assets:check` is the source of truth for "current".
- No runtime Python in CI. Pipeline runs locally only.

## Gotchas

- `pnpm assets:build` requires `uv` on `PATH`. Install before first
  run.
- `uv run --directory tools build` resolves `build` from
  `[project.scripts]` in `pyproject.toml`. If you add a stage, wire it
  through `__main__.build()` rather than adding a new script.
