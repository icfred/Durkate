"""Parse packages/ui/src/tokens.ts and dump the color palette to JSON.

Idempotent. Run via:
    uv run --directory tools python -m spikes.scripts.export_palette

Writes to tools/spikes/palette.json (committed). The crusher reads this
JSON so the spike never depends on TypeScript tooling at runtime.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

TOKENS_TS = Path(__file__).resolve().parents[3] / "packages" / "ui" / "src" / "tokens.ts"
OUT = Path(__file__).resolve().parents[1] / "palette.json"

COLOR_BLOCK = re.compile(r"export const color\s*=\s*\{([^}]+)\}", re.S)
COLOR_LINE = re.compile(r"^\s*([a-zA-Z]+)\s*:\s*0x([0-9a-fA-F]{6})\s*,?\s*$", re.M)


def parse_palette(source: str) -> dict[str, str]:
    block = COLOR_BLOCK.search(source)
    if not block:
        raise SystemExit("could not locate `export const color = {...}` block")
    pairs: dict[str, str] = {}
    for match in COLOR_LINE.finditer(block.group(1)):
        name, hex_rgb = match.group(1), match.group(2).lower()
        pairs[name] = f"#{hex_rgb}"
    if not pairs:
        raise SystemExit("color block had no parseable entries")
    return pairs


def main() -> None:
    text = TOKENS_TS.read_text(encoding="utf-8")
    pairs = parse_palette(text)
    payload = {
        "source": str(TOKENS_TS.relative_to(TOKENS_TS.parents[3])),
        "colors": pairs,
    }
    OUT.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUT.relative_to(OUT.parents[3])} ({len(pairs)} colors)")


if __name__ == "__main__":
    main()
