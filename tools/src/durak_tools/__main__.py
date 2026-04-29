"""Entry points wired to pnpm scripts.

`pnpm assets:build` -> `uv run --directory tools build`  -> build()
`pnpm assets:check` -> `uv run --directory tools check`  -> check()

Both are no-ops today. Future tickets fill in the four stages
(scrape -> convert -> pack -> emit) and a checksum-based check.
"""

from __future__ import annotations

import sys

from durak_tools import converter, index_emitter, packer, scraper, skins


def build() -> None:
    scraper.run()
    converter.run()
    packer.run()
    index_emitter.run()
    skins.run()
    print("assets:build - skins atlas baked")


def check() -> None:
    print("assets:check - clean (scaffold)")


def _dispatch() -> None:
    if len(sys.argv) < 2:
        print("usage: python -m durak_tools <build|check>", file=sys.stderr)
        sys.exit(2)
    command = sys.argv[1]
    if command == "build":
        build()
    elif command == "check":
        check()
    else:
        print(f"unknown command: {command}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    _dispatch()
