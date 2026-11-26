"""Make one short clip per voice across your TTS providers, then a page to listen to them.

Writes samples/*.mp3|wav and voices.html. Uses the same keys as keytest.py.
Edge TTS goes through the proxy in TTS_PROXY (.env) when one is set, otherwise direct.

Usage: python voice_samples.py
"""
import asyncio
import base64
import html
import json
import os
import time
import uuid

import aiohttp
import edge_tts

import keytest as k

TEXT = "Hey, it's me. Testing one, two, three."
OUT = os.path.join(k.HERE, "samples")
EDGE_PROXY = None  # set from TTS_PROXY in .env at start-up; never hardcode a proxy, it carries a password


def first(keys, prov, suffix=None):
    for key in keys.get(prov, {}):
        if suffix is None or key.endswith(suffix):
            return key


async def fetch_audio(s, url, **kw):
    t = time.perf_counter()
    async with s.post(url, **kw) as r:
        body = await r.read()
        ms = (time.perf_counter() - t) * 1000
        if r.status != 200:
            raise RuntimeError(f"{r.status} {k.err(body.decode(errors='replace'))}")
        return body, ms


async def edge(s, keys, cfg, voice):
    t = time.perf_counter()
    audio = b""
    async for c in edge_tts.Communicate(TEXT, voice, proxy=EDGE_PROXY).stream():
        if c["type"] == "audio":
            audio += c["data"]
    return audio, (time.perf_counter() - t) * 1000, "mp3"


async def eleven(s, keys, cfg, voice_id, model):
    body, ms = await fetch_audio(s, f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=mp3_44100_64",
                                 headers={"xi-api-key": first(keys, "elevenlabs")}, json={"text": TEXT, "model_id": model})
    return body, ms, "mp3"


async def fish(s, keys, cfg, voice_id):
    body, ms = await fetch_audio(s, "https://api.fish.audio/v1/tts",
                                 headers={"authorization": f"Bearer {first(keys, 'fish')}", "model": cfg.get("FISH_MODEL", "s2.1-pro-free")},
                                 json={"text": TEXT, "reference_id": voice_id, "format": "mp3", "mp3_bitrate": 64})
    return body, ms, "mp3"


async def inworld(s, keys, cfg, voice):
    body, ms = await fetch_audio(s, "https://api.inworld.ai/tts/v1/voice", headers={"authorization": f"Basic {first(keys, 'inworld')}"},
                                 json={"text": TEXT, "voiceId": voice, "modelId": "inworld-tts-2-flash", "audioConfig": {"audioEncoding": "MP3"}})
    return base64.b64decode(json.loads(body)["audioContent"]), ms, "mp3"


async def google(s, keys, cfg, voice):
    key = first(keys, "google_tts")
    body, ms = await fetch_audio(s, f"https://texttospeech.googleapis.com/v1/text:synthesize?key={key}",
                                 json={"input": {"text": TEXT}, "voice": {"languageCode": "en-US", "name": voice}, "audioConfig": {"audioEncoding": "MP3"}})
    return base64.b64decode(json.loads(body)["audioContent"]), ms, "mp3"


async def groq(s, keys, cfg, voice):
    body, ms = await fetch_audio(s, "https://api.groq.com/openai/v1/audio/speech", headers={"Authorization": f"Bearer {first(keys, 'groq')}"},
                                 json={"model": "canopylabs/orpheus-v1-english", "input": TEXT, "voice": voice, "response_format": "wav"})
    return body, ms, "wav"


async def qwen(s, keys, cfg, voice):
    host = cfg.get("DASHSCOPE_HOST", "dashscope-intl.aliyuncs.com").replace("wss://", "").split("/")[0]
    tid = uuid.uuid4().hex
    t = time.perf_counter()
    audio = b""
    async with s.ws_connect(f"wss://{host}/api-ws/v1/inference", headers={"Authorization": f"bearer {first(keys, 'qwen')}"}) as ws:
        send = lambda a, p: ws.send_str(json.dumps({"header": {"action": a, "task_id": tid, "streaming": "duplex"}, "payload": p}))
        await send("run-task", {"task_group": "audio", "task": "tts", "function": "SpeechSynthesizer", "model": cfg.get("QWEN_MODEL", "qwen-audio-3.0-tts-flash"),
                                "parameters": {"text_type": "PlainText", "voice": voice, "format": "mp3", "sample_rate": 24000}, "input": {}})
        async for msg in ws:
            if msg.type == aiohttp.WSMsgType.BINARY:
                audio += msg.data
            elif msg.type == aiohttp.WSMsgType.TEXT:
                h = json.loads(msg.data)["header"]
                if h.get("event") == "task-started":
                    await send("continue-task", {"input": {"text": TEXT}})
                    await send("finish-task", {"input": {}})
                elif h.get("event") == "task-failed":
                    raise RuntimeError(f"{h.get('error_code')}: {h.get('error_message', '')[:100]}")
                elif h.get("event") == "task-finished":
                    break
    return audio, (time.perf_counter() - t) * 1000, "mp3"


async def main():
    keys, cfg = k.load()
    global EDGE_PROXY
    EDGE_PROXY = cfg.get("TTS_PROXY") or os.environ.get("TTS_PROXY") or None
    qwen_voice = cfg.get("QWEN_VOICE_ID", "longanhuan_v3.6")
    # (provider, label, note, coroutine factory)
    plan = [
        ("Fish Audio", "Your cloned voice", "FISH_VOICE_ID from .env, s2.1-pro-free", lambda s: fish(s, keys, cfg, cfg.get("FISH_VOICE_ID"))),
        ("Fish Audio", "Modern Conversational Youth", "saved voice", lambda s: fish(s, keys, cfg, "57a59cabbc1443f1a28ce1998c0a8f3b")),
        ("ElevenLabs", "Bella", "eleven_v4", lambda s: eleven(s, keys, cfg, "hpp4J3VqNfWAUOO0d1Us", "eleven_v4")),
        ("ElevenLabs", "George", "eleven_v4_turbo", lambda s: eleven(s, keys, cfg, "JBFqnCBsd6RMkjVDRZzb", "eleven_v4_turbo")),
        ("ElevenLabs", "Roger", "eleven_flash_v2_5", lambda s: eleven(s, keys, cfg, "CwhRBWXzGAHq8TQ4Fs17", "eleven_flash_v2_5")),
        ("Google Cloud", "Chirp3-HD Achernar", "the Read Aloud voice", lambda s: google(s, keys, cfg, "en-US-Chirp3-HD-Achernar")),
        ("Google Cloud", "Chirp3-HD Charon", "", lambda s: google(s, keys, cfg, "en-US-Chirp3-HD-Charon")),
        ("Google Cloud", "Chirp3-HD Kore", "", lambda s: google(s, keys, cfg, "en-US-Chirp3-HD-Kore")),
        ("Inworld", "Hana", "tts-2-flash", lambda s: inworld(s, keys, cfg, "Hana")),
        ("Inworld", "Dennis", "tts-2-flash", lambda s: inworld(s, keys, cfg, "Dennis")),
        ("Inworld", "Ashley", "tts-2-flash", lambda s: inworld(s, keys, cfg, "Ashley")),
        ("Groq", "Troy", "Orpheus v1", lambda s: groq(s, keys, cfg, "troy")),
        ("Groq", "Hannah", "Orpheus v1", lambda s: groq(s, keys, cfg, "hannah")),
        ("Qwen (Alibaba)", qwen_voice.split("-")[-1][:12], "your configured QWEN_VOICE_ID", lambda s: qwen(s, keys, cfg, qwen_voice)),
        ("Edge TTS", "Ava", "free, via Paris proxy", lambda s: edge(s, keys, cfg, "en-US-AvaNeural")),
        ("Edge TTS", "Andrew", "free, via Paris proxy", lambda s: edge(s, keys, cfg, "en-US-AndrewMultilingualNeural")),
        ("Edge TTS", "Sonia (UK)", "free, via Paris proxy", lambda s: edge(s, keys, cfg, "en-GB-SoniaNeural")),
    ]
    os.makedirs(OUT, exist_ok=True)
    results = []
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=60)) as s:
        for prov, label, note, make in plan:
            try:
                audio, ms, ext = await make(s)
                name = f"{prov}_{label}".lower().replace(" ", "_").replace("(", "").replace(")", "") + f".{ext}"
                with open(os.path.join(OUT, name), "wb") as f:
                    f.write(audio)
                results.append((prov, label, note, f"samples/{name}", f"{ms/1000:.2f}s", ""))
                print(f"OK   {prov:<15} {label:<28} {ms:6.0f}ms")
            except Exception as e:
                results.append((prov, label, note, None, "", str(e)[:120]))
                print(f"FAIL {prov:<15} {label:<28} {e}")

    rows = []
    for prov, label, note, path, took, error in results:
        player = f'<audio controls preload="none" src="{html.escape(path)}"></audio>' if path else f'<span class="err">{html.escape(error)}</span>'
        rows.append(f"<tr><td>{html.escape(prov)}</td><td><b>{html.escape(label)}</b><div class='note'>{html.escape(note)}</div></td><td>{took}</td><td>{player}</td></tr>")
    page = f"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Voice Samples</title><style>
:root{{--bg:#fff;--fg:#1a1a1a;--muted:#666;--line:#e5e5e5;--err:#b42318}}
@media (prefers-color-scheme:dark){{:root{{--bg:#161616;--fg:#eee;--muted:#999;--line:#333;--err:#f97066}}}}
body{{background:var(--bg);color:var(--fg);font:15px/1.4 system-ui,sans-serif;margin:0;padding:24px 16px;max-width:900px;margin:auto}}
h1{{font-size:20px;margin:0 0 4px}} p{{color:var(--muted);margin:0 0 16px}}
table{{width:100%;border-collapse:collapse}} td,th{{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:middle}}
th{{font-size:12px;text-transform:uppercase;color:var(--muted)}} .note{{font-size:12px;color:var(--muted)}} .err{{color:var(--err);font-size:13px}}
audio{{height:32px;max-width:280px}}
</style></head><body><h1>Voice samples</h1><p>Every clip says: "{html.escape(TEXT)}" · Time = full clip generated</p>
<table><tr><th>Provider</th><th>Voice</th><th>Time</th><th>Listen</th></tr>{''.join(rows)}</table></body></html>"""
    with open(os.path.join(k.HERE, "voices.html"), "w", encoding="utf-8") as f:
        f.write(page)
    print("Wrote voices.html")


if __name__ == "__main__":
    asyncio.run(main())
