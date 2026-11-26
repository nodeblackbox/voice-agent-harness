"""Quick Edge TTS latency tester.

Measures, per text length:
  - TTFB: time until the first audio chunk arrives (what you "feel" as delay)
  - Total: time until all audio has been received
  - Audio bytes received

Usage:
  python tts_latency.py                 # default voice, 3 runs each
  python tts_latency.py --voice en-US-GuyNeural --runs 5
"""
import argparse
import asyncio
import os
import statistics
import time

import edge_tts

TEXTS = {
    "1 word": "Hello.",
    "short sentence": "Hey, how are you doing today?",
    "long sentence": (
        "I just wanted to check in and see whether the package arrived on time, "
        "because the tracking page said it was delayed."
    ),
    "paragraph": (
        "Text to speech latency depends on a few things: the network round trip to "
        "Microsoft's servers, how long the service takes to start synthesizing, and "
        "how much text you send. Short phrases should come back quickly, while long "
        "paragraphs take longer to finish streaming. If the first chunk itself is "
        "slow, the problem is usually the connection or the service, not the length "
        "of your text."
    ),
}


def load_proxies(path):
    """Read ip:port:user:pass lines -> list of (label, proxy_url)."""
    out = []
    with open(path) as f:
        for line in f:
            parts = line.strip().split(":")
            if len(parts) == 4:
                ip, port, user, pw = parts
                out.append((f"{ip}:{port}", f"http://{user}:{pw}@{ip}:{port}"))
            elif len(parts) == 2:
                out.append((line.strip(), f"http://{line.strip()}"))
    return out


async def measure(text: str, voice: str, proxy=None):
    start = time.perf_counter()
    ttfb = None
    nbytes = 0
    comm = edge_tts.Communicate(text, voice, proxy=proxy)
    async for chunk in comm.stream():
        if chunk["type"] == "audio":
            if ttfb is None:
                ttfb = time.perf_counter() - start
            nbytes += len(chunk["data"])
    total = time.perf_counter() - start
    return ttfb, total, nbytes


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--voice", default="en-US-AriaNeural")
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--proxies", help="file of ip:port:user:pass lines; compares direct vs each proxy")
    args = ap.parse_args()

    if args.proxies:
        await compare_proxies(args)
        return

    print(f"Voice: {args.voice}   Runs per text: {args.runs}\n")
    print(f"{'Text':<16}{'chars':>6}  {'TTFB min/avg/max (ms)':>24}  {'Total min/avg/max (ms)':>24}  {'KB':>6}")
    print("-" * 84)
    for name, text in TEXTS.items():
        ttfbs, totals, kb = [], [], 0
        for _ in range(args.runs):
            try:
                ttfb, total, nbytes = await measure(text, args.voice)
            except Exception as e:
                print(f"{name:<16} ERROR: {e!r}")
                break
            ttfbs.append(ttfb * 1000)
            totals.append(total * 1000)
            kb = nbytes / 1024
        if not ttfbs:
            continue
        fmt = lambda xs: f"{min(xs):.0f}/{statistics.mean(xs):.0f}/{max(xs):.0f}"
        print(f"{name:<16}{len(text):>6}  {fmt(ttfbs):>24}  {fmt(totals):>24}  {kb:>6.1f}")


async def country(proxy):
    """Exit country/city of a route, via ip-api.com (free, no key)."""
    import aiohttp
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as s:
            async with s.get("http://ip-api.com/json?fields=countryCode,city", proxy=proxy) as r:
                j = await r.json()
                return f"{j.get('countryCode', '?')} {j.get('city', '')}".strip()
    except Exception:
        return "?"


async def compare_proxies(args):
    """Short sentence through no proxy, then each proxy, ranked fastest first.

    Writes proxies_ranked.txt next to the proxy file: the same ip:port:user:pass lines,
    fastest first, failures dropped, so an app can just take the top line.
    Credentials are never printed.
    """
    text = TEXTS["short sentence"]
    proxies = load_proxies(args.proxies)
    routes = [("DIRECT (your IP)", None)] + [(label, url) for label, url in proxies]
    raw = {label: line.strip() for (label, _), line in zip(proxies, [l for l in open(args.proxies) if len(l.strip().split(":")) in (2, 4)])}
    where = await asyncio.gather(*(country(p) for _, p in routes))
    print(f"Testing {len(routes)} routes, {args.runs} runs each ({args.voice}, {text!r})...")
    results = []  # (avg_ttfb or None, label, loc, min, max, total_avg, err)
    for i, ((label, proxy), loc) in enumerate(zip(routes, where), 1):
        ttfbs, totals, err = [], [], None
        for _ in range(args.runs):
            try:
                ttfb, total, _ = await asyncio.wait_for(measure(text, args.voice, proxy), 20)
                ttfbs.append(ttfb * 1000)
                totals.append(total * 1000)
            except Exception as e:
                err = type(e).__name__ + (f" {getattr(e, 'status', '')}" if getattr(e, "status", None) else "")
                break
        avg = statistics.mean(ttfbs) if ttfbs else None
        results.append((avg, label, loc, min(ttfbs, default=0), max(ttfbs, default=0), statistics.mean(totals) if totals else 0, err))
        print(f"  [{i}/{len(routes)}] {label}: {f'{avg:.0f}ms' if avg else 'FAIL ' + str(err)}", flush=True)

    results.sort(key=lambda r: (r[0] is None, r[0] or 0))
    print(f"\n{'#':>3}  {'Route':<24}{'Exit':<20}{'TTFB min/avg/max (ms)':>24}  {'Total avg (ms)':>15}  Status")
    print("-" * 104)
    for n, (avg, label, loc, lo, hi, tot, err) in enumerate(results, 1):
        if avg is None:
            print(f"{'-':>3}  {label:<24}{loc[:19]:<20}{'-':>24}  {'-':>15}  FAIL: {err}")
        else:
            print(f"{n:>3}  {label:<24}{loc[:19]:<20}{f'{lo:.0f}/{avg:.0f}/{hi:.0f}':>24}  {tot:>15.0f}  {'ok' if not err else 'partial: ' + err}")

    best = {}
    for avg, label, loc, *_ in results:
        if avg is not None and label in raw:
            best.setdefault(loc.split(" ")[0], (label, avg))
    print("\nFastest per country: " + ", ".join(f"{c} {l} ({a:.0f}ms)" for c, (l, a) in best.items()))

    out = os.path.join(os.path.dirname(os.path.abspath(args.proxies)), "proxies_ranked.txt")
    with open(out, "w") as f:
        f.write("\n".join(raw[label] for avg, label, *_ in results if avg is not None and label in raw) + "\n")
    print(f"Wrote {out} (fastest first)")


if __name__ == "__main__":
    asyncio.run(main())
