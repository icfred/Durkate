"""Durak asset pipeline.

Stages: scrape -> convert -> pack -> emit typed index.
"""

__all__ = ["scraper", "converter", "packer", "index_emitter"]
