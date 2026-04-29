"""Minimal HTTP layer for the spike: throttled GET, robots.txt check, UA.

stdlib `urllib` only — no new dep. The throttle and robots cache are
process-local; spike runs are short-lived.
"""

from __future__ import annotations

import logging
import time
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

UA = "DurakTools/0.1 (image-pipeline-spike; +https://github.com/icfred/durak-2)"
THROTTLE_SECONDS = 0.6  # >= 500ms required by ticket; 600ms gives a margin.
DEFAULT_TIMEOUT = 20.0

log = logging.getLogger("spikes.http")


@dataclass
class FetchResult:
    url: str
    status: int
    body: bytes
    content_type: str
    elapsed_s: float


@dataclass
class FetchRefusal:
    url: str
    reason: str  # "robots", "http-error", "non-image", "size-cap", "fetch-error"
    detail: str = ""


@dataclass
class HttpClient:
    timeout: float = DEFAULT_TIMEOUT
    throttle_seconds: float = THROTTLE_SECONDS
    max_bytes: int = 8 * 1024 * 1024  # 8 MiB hard cap per file
    # Off by default. Opt in only when the source publishes a separate
    # API/UA policy that supersedes its robots.txt — e.g. Wikimedia's
    # https://meta.wikimedia.org/wiki/User-Agent_policy authorises API
    # consumers with a proper UA + reasonable throttle. With this True,
    # `can_fetch` short-circuits to True for every URL on this client.
    ignore_robots: bool = False
    _last_hit: dict[str, float] = field(default_factory=dict)
    _robots: dict[str, urllib.robotparser.RobotFileParser] = field(default_factory=dict)
    refusals: list[FetchRefusal] = field(default_factory=list)

    def _host(self, url: str) -> str:
        return urllib.parse.urlsplit(url).hostname or ""

    def _wait_for_host(self, host: str) -> None:
        last = self._last_hit.get(host, 0.0)
        delta = time.monotonic() - last
        if delta < self.throttle_seconds:
            time.sleep(self.throttle_seconds - delta)
        self._last_hit[host] = time.monotonic()

    def _robots_for(self, url: str) -> urllib.robotparser.RobotFileParser:
        scheme = urllib.parse.urlsplit(url).scheme or "https"
        host = self._host(url)
        if host not in self._robots:
            parser = urllib.robotparser.RobotFileParser()
            robots_url = f"{scheme}://{host}/robots.txt"
            parser.set_url(robots_url)
            try:
                self._wait_for_host(host)
                # urllib.robotparser fetches with default Python UA which
                # Wikimedia and others 403; explicit UA fetch + parse() avoids
                # the conservative "treat everything as disallowed" fallback.
                request = urllib.request.Request(
                    robots_url, headers={"User-Agent": UA, "Accept": "text/plain"}
                )
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    text = response.read().decode("utf-8", errors="replace")
                parser.parse(text.splitlines())
            except urllib.error.HTTPError as exc:
                # 404 -> permissive per spec; other errors -> conservative.
                if exc.code == 404:
                    parser.allow_all = True
                else:
                    parser.disallow_all = True
                log.warning("robots fetch http %s for %s", exc.code, host)
            except Exception as exc:
                log.warning("robots fetch failed for %s: %s", host, exc)
            self._robots[host] = parser
        return self._robots[host]

    def can_fetch(self, url: str) -> bool:
        if self.ignore_robots:
            return True
        return self._robots_for(url).can_fetch(UA, url)

    def get(self, url: str) -> Optional[FetchResult]:
        if not self.can_fetch(url):
            self.refusals.append(FetchRefusal(url=url, reason="robots"))
            log.info("robots refused %s", url)
            return None
        host = self._host(url)
        self._wait_for_host(host)
        request = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
        started = time.monotonic()
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                content_type = response.headers.get("Content-Type", "")
                body = response.read(self.max_bytes + 1)
                if len(body) > self.max_bytes:
                    self.refusals.append(
                        FetchRefusal(url=url, reason="size-cap", detail=f">{self.max_bytes} bytes")
                    )
                    return None
                return FetchResult(
                    url=url,
                    status=response.status,
                    body=body,
                    content_type=content_type,
                    elapsed_s=time.monotonic() - started,
                )
        except urllib.error.HTTPError as exc:
            self.refusals.append(FetchRefusal(url=url, reason="http-error", detail=str(exc.code)))
            log.warning("http %s on %s", exc.code, url)
        except Exception as exc:
            self.refusals.append(FetchRefusal(url=url, reason="fetch-error", detail=str(exc)))
            log.warning("fetch failed for %s: %s", url, exc)
        return None

    def save(self, url: str, dest: Path) -> Optional[Path]:
        result = self.get(url)
        if result is None:
            return None
        if not result.content_type.startswith("image/"):
            self.refusals.append(
                FetchRefusal(url=url, reason="non-image", detail=result.content_type)
            )
            return None
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(result.body)
        return dest

    def refusal_summary(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for refusal in self.refusals:
            counts[refusal.reason] = counts.get(refusal.reason, 0) + 1
        return counts
