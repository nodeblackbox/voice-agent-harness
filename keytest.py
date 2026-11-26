"""Test every LLM and voice API key across your projects, with latency.

Each key gets the cheapest call that proves it works (list models, then a reply
of a few words or a one-word voice clip). Keys are never printed in full.
Full model and voice lists go to catalog.md next to this script.

Usage:
  python keytest.py              # everything
  python keytest.py llm          # only LLM providers
  python keytest.py voice        # only voice providers
"""
import asyncio
import base64
import json
import os
import sys
import time
import uuid

import aiohttp
import anthropic

HERE = os.path.dirname(os.path.abspath(__file__))
ENV_FILES = [
    os.path.join(HERE, ".env"),
    os.path.join(HERE, "extra_keys.env"),
    # more .env files to check, separated like PATH is (";" on Windows): KEYTEST_ENV_FILES=C:\a\.env;C:\b\.env
    *[f for f in os.environ.get("KEYTEST_ENV_FILES", "").split(os.pathsep) if f],
]
PROMPT = "Reply with just the word: ok"
SAY = "Hi."
TIMEOUT = aiohttp.ClientTimeout(total=30)

# env var name prefix -> provider
PROVIDERS = {
    "ANTHROPIC_API_KEY": "anthropic", "OPENAI_API_KEY": "openai", "XAI_API_KEY": "xai",
    "GROQ_API_KEY": "groq", "GROQ_KEYS": "groq", "GEMINI_API_KEY": "gemini",
    "OPENROUTER_API_KEY": "openrouter", "ELEVENLABS_API_KEY": "elevenlabs",
    "FISH_API_KEY": "fish", "INWORLD_API_KEY": "inworld", "DASHSCOPE_API_KEY": "qwen",
    "GOOGLE_TTS_API_KEY": "google_tts",
}
LLM = {"anthropic", "openai", "xai", "groq", "gemini", "openrouter"}

rows = []
catalog = {}


def mask(k):
    return f"{k[:8]}…{k[-4:]}" if len(k) > 14 else "…"


def load():
    """provider -> {key: [sources]}, plus non-key settings (voice ids, hosts)."""
    keys, settings = {}, {}
    for path in ENV_FILES:
        if not os.path.exists(path):
            continue
        proj = os.path.basename(os.path.dirname(path)) if not path.endswith("extra_keys.env") else "pasted"
        for line in open(path, encoding="utf-8", errors="replace"):
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            name, val = (s.strip() for s in line.split("=", 1))
            val = val.strip('"').strip("'")
            if not val:
                continue
            prov = next((p for pre, p in PROVIDERS.items() if name.startswith(pre)), None)
            if prov is None:
                settings.setdefault(name, val)
                continue
            vals = [val]
            if name == "GROQ_KEYS":
                try:
                    vals = [d["key"] if isinstance(d, dict) else d for d in json.loads(val)]
                except Exception:
                    continue
            for v in vals:
                keys.setdefault(prov, {}).setdefault(v, [])
                if proj not in keys[prov][v]:
                    keys[prov][v].append(proj)
    return keys, settings


def add(provider, key, sources, ok, ms, detail):
    rows.append((provider, mask(key), ",".join(sources), "OK" if ok else "FAIL", f"{ms:.0f}" if ms is not None else "-", detail))


async def get(s, url, **kw):
    t = time.perf_counter()
    async with s.get(url, **kw) as r:
        body = await r.text()
        return r.status, body, (time.perf_counter() - t) * 1000


async def post(s, url, **kw):
    t = time.perf_counter()
    async with s.post(url, **kw) as r:
        body = await r.text()
        return r.status, body, (time.perf_counter() - t) * 1000


async def post_audio(s, url, **kw):
    """POST and time the first audio byte. Returns status, ttfb_ms, total_ms, bytes, error_text."""
    t = time.perf_counter()
    async with s.post(url, **kw) as r:
        if r.status != 200:
            return r.status, None, (time.perf_counter() - t) * 1000, 0, (await r.text())[:200]
        ttfb, n = None, 0
        async for chunk in r.content.iter_any():
            if ttfb is None:
                ttfb = (time.perf_counter() - t) * 1000
            n += len(chunk)
        return 200, ttfb, (time.perf_counter() - t) * 1000, n, ""


def err(body):
    try:
        j = json.loads(body)
        e = j.get("error", j)
        if isinstance(e, dict):
            return str(e.get("message") or e.get("detail") or e)[:140]
        return str(e)[:140]
    except Exception:
        return body.strip().replace("\n", " ")[:140]


def pick(ids, prefs):
    for p in prefs:
        for i in ids:
            if p in i:
                return i
    return ids[0] if ids else None


# ---------------------------------------------------------------- LLMs

async def t_anthropic(s, key, src):
    client = anthropic.AsyncAnthropic(api_key=key, max_retries=0, timeout=30)
    try:
        t = time.perf_counter()
        models = [m.id async for m in client.models.list()]
        list_ms = (time.perf_counter() - t) * 1000
        catalog.setdefault("anthropic", models)
        model = "claude-haiku-5-5" if "claude-haiku-5-5" in models else pick(models, ["haiku"])
        t = time.perf_counter()
        r = await client.messages.create(
            model=model, max_tokens=300, output_config={"effort": "low"},
            messages=[{"role": "user", "content": PROMPT}],
        )
        ms = (time.perf_counter() - t) * 1000
        text = next((b.text for b in r.content if b.type == "text"), "").strip()
        add("anthropic", key, src, True, ms, f"{model} -> {text!r} | {len(models)} models (list {list_ms:.0f}ms)")
    except anthropic.AuthenticationError:
        add("anthropic", key, src, False, None, "401 invalid key (revoked or deleted)")
    except anthropic.PermissionDeniedError as e:
        add("anthropic", key, src, False, None, f"403 {e.message[:120]}")
    except anthropic.RateLimitError as e:
        add("anthropic", key, src, False, None, f"429 {e.message[:120]}")
    except anthropic.APIStatusError as e:
        add("anthropic", key, src, False, None, f"{e.status_code} {e.message[:120]}")
    except anthropic.APIConnectionError as e:
        add("anthropic", key, src, False, None, f"network: {e}")


async def t_openai_like(s, name, base, key, src, prefs, models_key="data"):
    H = {"Authorization": f"Bearer {key}"}
    st, body, list_ms = await get(s, f"{base}/models", headers=H)
    if st != 200:
        return add(name, key, src, False, None, f"{st} {err(body)}")
    ids = sorted(m["id"] for m in json.loads(body)[models_key])
    catalog.setdefault(name, ids)
    chat_ids = [i for i in ids if not any(x in i for x in ("tts", "whisper", "embed", "image", "audio", "guard", "moderation", "realtime", "transcribe", "dall", "sora", "imagine", "video"))]
    model = pick(chat_ids, prefs)
    st, body, ms = await post(s, f"{base}/chat/completions", headers=H, json={
        "model": model, "messages": [{"role": "user", "content": PROMPT}],
        **({"max_completion_tokens": 300} if name == "openai" else {"max_tokens": 300}),
    })
    if st != 200:
        return add(name, key, src, False, ms, f"models OK ({len(ids)}), chat {model} -> {st} {err(body)}")
    text = (json.loads(body)["choices"][0]["message"].get("content") or "").strip()
    add(name, key, src, True, ms, f"{model} -> {text[:20]!r} | {len(ids)} models (list {list_ms:.0f}ms)")


async def t_gemini(s, key, src):
    H = {"x-goog-api-key": key}
    base = "https://generativelanguage.googleapis.com/v1beta"
    st, body, list_ms = await get(s, f"{base}/models?pageSize=200", headers=H)
    if st != 200:
        return add("gemini", key, src, False, None, f"{st} {err(body)}")
    ms_ = json.loads(body).get("models", [])
    ids = sorted(m["name"].split("/")[-1] for m in ms_ if "generateContent" in m.get("supportedGenerationMethods", []))
    catalog.setdefault("gemini", ids)
    model = pick([i for i in ids if "tts" not in i and "image" not in i and "preview" not in i] or ids, ["flash-lite-latest", "flash-lite", "flash"])
    st, body, ms = await post(s, f"{base}/models/{model}:generateContent", headers=H, json={
        "contents": [{"parts": [{"text": PROMPT}]}], "generationConfig": {"maxOutputTokens": 300},
    })
    if st != 200:
        return add("gemini", key, src, False, ms, f"models OK ({len(ids)}), {model} -> {st} {err(body)}")
    try:
        text = json.loads(body)["candidates"][0]["content"]["parts"][0]["text"].strip()
    except Exception:
        text = "(no text)"
    add("gemini", key, src, True, ms, f"{model} -> {text[:20]!r} | {len(ids)} models (list {list_ms:.0f}ms)")


async def t_openrouter(s, key, src):
    st, body, ms = await get(s, "https://openrouter.ai/api/v1/key", headers={"Authorization": f"Bearer {key}"})
    if st != 200:
        return add("openrouter", key, src, False, ms, f"{st} {err(body)}")
    d = json.loads(body).get("data", {})
    add("openrouter", key, src, True, ms, f"used ${d.get('usage', 0):.2f}, limit {d.get('limit')}, free tier {d.get('is_free_tier')}")


# ---------------------------------------------------------------- voice

async def t_elevenlabs(s, key, src, cfg):
    H = {"xi-api-key": key}
    st, body, _ = await get(s, "https://api.elevenlabs.io/v1/user/subscription", headers=H)
    quota = ""
    if st == 200:
        d = json.loads(body)
        quota = f"{d.get('character_count')}/{d.get('character_limit')} chars used ({d.get('tier')})"
    st, body, _ = await get(s, "https://api.elevenlabs.io/v2/voices?page_size=100", headers=H)
    if st != 200:
        return add("elevenlabs", key, src, False, None, f"voices {st} {err(body)}")
    voices = json.loads(body).get("voices", [])
    st, mbody, _ = await get(s, "https://api.elevenlabs.io/v1/models", headers=H)
    models = [m["model_id"] for m in json.loads(mbody)] if st == 200 else []
    catalog.setdefault("elevenlabs voices", [f"{v['name']} [{v.get('category')}] {v['voice_id']}" for v in voices])
    catalog.setdefault("elevenlabs models", models)
    # "professional" voices saved from the library are not yours; only cloned/generated are
    own = [v for v in voices if v.get("category") in ("cloned", "generated")]
    library = [v for v in voices if v.get("category") == "professional"]
    stock = [v for v in voices if v.get("category") == "premade"]
    tests = [(v, "eleven_flash_v2_5", "your voice") for v in own[:1]]
    tests += [(v, "eleven_flash_v2_5", "library voice") for v in library[:1]]
    tests += [(stock[0], m, "stock voice") for m in ("eleven_flash_v2_5", "eleven_v4_turbo", "eleven_v4", "eleven_v3") if stock and m in models]
    for v, model, kind in tests:
        st, ttfb, total, n, e = await post_audio(
            s, f"https://api.elevenlabs.io/v1/text-to-speech/{v['voice_id']}/stream?output_format=mp3_44100_64",
            headers={**H, "accept": "audio/mpeg"}, json={"text": SAY, "model_id": model})
        name = v["name"].split(" - ")[0]
        if st == 200:
            add("elevenlabs", key, src, True, ttfb, f"{kind} '{name}' {model}: {n/1024:.1f}KB, total {total:.0f}ms | {quota}")
        else:
            add("elevenlabs", key, src, False, None, f"{kind} '{name}' {model} -> {st} {err(e)[:90]}")
    if not own:
        add("elevenlabs", key, src, False, None, "no cloned voice of your own on this account")


async def t_fish(s, key, src, cfg):
    H = {"authorization": f"Bearer {key}"}
    st, body, _ = await get(s, "https://api.fish.audio/wallet/self/api-credit", headers=H)
    credit = f"credit {json.loads(body).get('credit')}" if st == 200 else f"credit check {st}"
    st, body, _ = await get(s, "https://api.fish.audio/model?self=true&page_size=50", headers=H)
    if st == 200:
        catalog.setdefault("fish (your voices)", [f"{m['title']} {m['_id']}" for m in json.loads(body).get("items", [])])
    voice = cfg.get("FISH_VOICE_ID", "933563129e564b19a115bedd57b7406a")
    model = cfg.get("FISH_MODEL", "s2.1-pro-free")
    st, ttfb, total, n, e = await post_audio(s, "https://api.fish.audio/v1/tts", headers={**H, "model": model},
                                             json={"text": SAY, "reference_id": voice, "format": "mp3", "mp3_bitrate": 64, "latency": "balanced"})
    if st == 200:
        add("fish", key, src, True, ttfb, f"{model} voice {voice[:8]}: {n/1024:.1f}KB, total {total:.0f}ms | {credit}")
    else:
        add("fish", key, src, False, None, f"{model} -> {st} {err(e)} | {credit}")


async def t_inworld(s, key, src, cfg):
    H = {"authorization": f"Basic {key}"}
    st, body, _ = await get(s, "https://api.inworld.ai/voices/v1/voices?pageSize=500", headers=H)
    if st == 200:
        vs = json.loads(body).get("voices", [])
        catalog.setdefault(f"inworld voices ({mask(key)})", [f"{v.get('displayName') or v['voiceId']} [{v.get('source', 'SYSTEM')}] {v['voiceId']}" for v in vs])
    t = time.perf_counter()
    async with s.post("https://api.inworld.ai/tts/v1/voice:stream", headers=H, json={
        "text": SAY, "voiceId": "Hana", "modelId": "inworld-tts-2-flash",
        "audioConfig": {"audioEncoding": "MP3", "bitRate": 64000, "sampleRateHertz": 24000}}) as r:
        if r.status != 200:
            return add("inworld", key, src, False, None, f"{r.status} {err(await r.text())}")
        ttfb, n, problem = None, 0, ""
        async for line in r.content:
            line = line.strip()
            if not line:
                continue
            j = json.loads(line)
            if j.get("error"):
                problem = j["error"].get("message", "error")
                break
            a = j.get("result", {}).get("audioContent")
            if a:
                ttfb = ttfb or (time.perf_counter() - t) * 1000
                n += len(base64.b64decode(a))
    total = (time.perf_counter() - t) * 1000
    if n:
        add("inworld", key, src, True, ttfb, f"tts-2-flash 'Hana': {n/1024:.1f}KB, total {total:.0f}ms")
    else:
        add("inworld", key, src, False, None, problem or "no audio")


async def t_qwen(s, key, src, cfg):
    host = cfg.get("DASHSCOPE_HOST", "dashscope-intl.aliyuncs.com")
    host = host.replace("wss://", "").replace("https://", "").split("/")[0]
    voice = cfg.get("QWEN_VOICE_ID", "longanhuan_v3.6")
    model = cfg.get("QWEN_MODEL", "qwen-audio-3.0-tts-flash")
    tid = uuid.uuid4().hex
    t = time.perf_counter()
    try:
        async with s.ws_connect(f"wss://{host}/api-ws/v1/inference", headers={"Authorization": f"bearer {key}"}) as ws:
            open_ms = (time.perf_counter() - t) * 1000
            send = lambda action, payload: ws.send_str(json.dumps({"header": {"action": action, "task_id": tid, "streaming": "duplex"}, "payload": payload}))
            t = time.perf_counter()
            await send("run-task", {"task_group": "audio", "task": "tts", "function": "SpeechSynthesizer", "model": model,
                                    "parameters": {"text_type": "PlainText", "voice": voice, "format": "mp3", "sample_rate": 24000}, "input": {}})
            ttfb, n = None, 0
            async for msg in ws:
                if msg.type == aiohttp.WSMsgType.BINARY:
                    ttfb = ttfb or (time.perf_counter() - t) * 1000
                    n += len(msg.data)
                elif msg.type == aiohttp.WSMsgType.TEXT:
                    h = json.loads(msg.data).get("header", {})
                    ev = h.get("event")
                    if ev == "task-started":
                        await send("continue-task", {"input": {"text": SAY}})
                        await send("finish-task", {"input": {}})
                    elif ev == "task-failed":
                        return add("qwen", key, src, False, None, f"{h.get('error_code')}: {h.get('error_message', '')[:120]}")
                    elif ev == "task-finished":
                        break
                else:
                    break
            total = (time.perf_counter() - t) * 1000
            add("qwen", key, src, bool(n), ttfb, f"{model} voice {voice[:14]}…: {n/1024:.1f}KB, total {total:.0f}ms (+{open_ms:.0f}ms socket open)")
    except aiohttp.WSServerHandshakeError as e:
        add("qwen", key, src, False, None, f"handshake {e.status} (bad key or host)")


async def t_google_tts(s, key, src, synth=True):
    """Cloud Text-to-Speech: list voices (free), then synthesize one word with Chirp3-HD Achernar."""
    st, body, list_ms = await get(s, f"https://texttospeech.googleapis.com/v1/voices?languageCode=en-US&key={key}")
    if st != 200:
        return add("google_tts", key, src, False, None, f"{st} {err(body)}")
    names = sorted(v["name"] for v in json.loads(body).get("voices", []))
    catalog.setdefault("google cloud tts en-US", names)
    target = next((n for n in names if "Chirp3-HD-Achernar" in n), None)
    if not synth or not target:
        return add("google_tts", key, src, True, list_ms, f"{len(names)} en-US voices; Achernar {'found' if target else 'missing'} (voice list only)")
    st, body, ms = await post(s, f"https://texttospeech.googleapis.com/v1/text:synthesize?key={key}", json={
        "input": {"text": SAY}, "voice": {"languageCode": "en-US", "name": target}, "audioConfig": {"audioEncoding": "MP3"}})
    if st != 200:
        return add("google_tts", key, src, False, ms, f"voices OK, synth {target} -> {st} {err(body)}")
    n = len(base64.b64decode(json.loads(body)["audioContent"]))
    add("google_tts", key, src, True, ms, f"{target}: {n/1024:.1f}KB | {len(names)} en-US voices")


async def t_groq_tts(s, key, src):
    models = [m for m in catalog.get("groq", []) if "tts" in m or "orpheus" in m]
    if not models:
        return add("groq_tts", key, src, False, None, "no TTS model listed for this key")
    model = pick(models, ["orpheus-v1-english", "orpheus", "playai-tts"])
    voice = "troy" if "orpheus" in model else "Fritz-PlayAI"
    st, ttfb, total, n, e = await post_audio(s, "https://api.groq.com/openai/v1/audio/speech", headers={"Authorization": f"Bearer {key}"},
                                             json={"model": model, "input": SAY, "voice": voice, "response_format": "wav"})
    if st == 200:
        add("groq_tts", key, src, True, ttfb, f"{model} '{voice}': {n/1024:.1f}KB, total {total:.0f}ms | TTS models: {', '.join(models)}")
    else:
        add("groq_tts", key, src, False, None, f"{model} -> {st} {err(e)}")


# ---------------------------------------------------------------- main

async def main():
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    keys, cfg = load()
    async with aiohttp.ClientSession(timeout=TIMEOUT) as s:
        async def run(coro, prov, key, src):
            try:
                await coro
            except Exception as e:
                add(prov, key, src, False, None, f"{type(e).__name__}: {str(e)[:120]}")

        jobs = []
        for prov, kv in keys.items():
            for key, src in kv.items():
                if which == "llm" and prov not in LLM or which == "voice" and prov in LLM:
                    continue
                if prov == "anthropic":
                    jobs.append(run(t_anthropic(s, key, src), prov, key, src))
                elif prov == "openai":
                    jobs.append(run(t_openai_like(s, "openai", "https://api.openai.com/v1", key, src, ["gpt-5-nano", "gpt-4.1-nano", "nano", "gpt-4o-mini", "mini"]), prov, key, src))
                elif prov == "xai":
                    jobs.append(run(t_openai_like(s, "xai", "https://api.x.ai/v1", key, src, ["mini-fast", "fast", "mini"]), prov, key, src))
                elif prov == "groq":
                    jobs.append(run(t_openai_like(s, "groq", "https://api.groq.com/openai/v1", key, src, ["llama-3.1-8b-instant", "8b", "instant"]), prov, key, src))
                elif prov == "gemini":
                    jobs.append(run(t_gemini(s, key, src), prov, key, src))
                    if key.startswith("AIza"):  # see which Gemini keys also have Cloud TTS enabled (free voice list)
                        jobs.append(run(t_google_tts(s, key, src, synth=False), "google_tts", key, src))
                elif prov == "openrouter":
                    jobs.append(run(t_openrouter(s, key, src), prov, key, src))
                elif prov == "elevenlabs":
                    jobs.append(run(t_elevenlabs(s, key, src, cfg), prov, key, src))
                elif prov == "fish":
                    jobs.append(run(t_fish(s, key, src, cfg), prov, key, src))
                elif prov == "inworld":
                    jobs.append(run(t_inworld(s, key, src, cfg), prov, key, src))
                elif prov == "qwen":
                    jobs.append(run(t_qwen(s, key, src, cfg), prov, key, src))
                elif prov == "google_tts":
                    jobs.append(run(t_google_tts(s, key, src), prov, key, src))
        for job in jobs:  # one at a time, so latencies aren't skewed by each other
            await job

        if which != "llm":  # Groq TTS needs the model list from the LLM pass
            main_groq = next(iter(keys.get("groq", {})), None)
            if main_groq:
                if "groq" not in catalog:
                    await t_openai_like(s, "groq", "https://api.groq.com/openai/v1", main_groq, keys["groq"][main_groq], ["llama-3.1-8b-instant"])
                await t_groq_tts(s, main_groq, keys["groq"][main_groq])

    rows.sort(key=lambda r: (r[0], r[3] != "OK"))
    w = [max(len(str(r[i])) for r in rows + [("Provider", "Key", "From", "Status", "ms", "")]) for i in range(5)]
    print(f"{'Provider':<{w[0]}}  {'Key':<{w[1]}}  {'From':<{w[2]}}  {'Status':<{w[3]}}  {'ms':>{w[4]}}  Detail")
    print("-" * 140)
    for r in rows:
        print(f"{r[0]:<{w[0]}}  {r[1]:<{w[1]}}  {r[2]:<{w[2]}}  {r[3]:<{w[3]}}  {r[4]:>{w[4]}}  {r[5]}")
    print("\nms = reply time for LLMs, time to first audio for voice.")

    with open(os.path.join(HERE, "catalog.md"), "w", encoding="utf-8") as f:
        f.write("# Models and voices available to your keys\n\n")
        for name, items in catalog.items():
            f.write(f"## {name} ({len(items)})\n\n" + "\n".join(f"- {i}" for i in items) + "\n\n")
    print(f"Full model and voice lists: catalog.md")


if __name__ == "__main__":
    asyncio.run(main())
