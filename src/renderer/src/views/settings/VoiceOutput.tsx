import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { Check, Gauge, Headphones, Play, type LucideIcon } from 'lucide-react'
import type { CloudTtsProvider, CloudVoiceChoice, ProxyRank, TtsCatalog, TtsEngineId, VoiceInfo } from '@shared/types'
import { CLOUD_TTS_PROVIDERS, TTS_ENGINE_LABELS, TTS_PROVIDERS, cloudChoice, isCloudTts, modelTakesTags } from '@shared/tts'
import { T, serviceColor, serviceLabel } from '../../theme'
import { keyedProviders, useStore } from '../../state/store'
import { Btn, Card, Dot, Row, Select, TextInput, Toggle } from '../../components/primitives'

const ENGINE_SUB: Record<TtsEngineId, string> = {
  edge: 'Free Microsoft voice, streamed sentence by sentence. If it is unreachable or rate-limited the local Kokoro voice takes over until it recovers.',
  kokoro: 'Runs on this machine (needs the sidecar Python). Slower to start, never rate-limited.',
  system: 'The Windows voice, spoken by the renderer. Always available.',
  elevenlabs: 'Hosted. Needs an ElevenLabs key; the free tier covers about ten thousand characters a month.',
  fish: 'Hosted. The free tier model works without credit; your own clones are listed once the key is set.',
  inworld: 'Hosted. Around two hundred milliseconds to first audio in testing; understands non-verbal cues.',
  qwen: 'Hosted on Alibaba Model Studio over a WebSocket kept open between sentences. Set DASHSCOPE_HOST for a workspace endpoint.'
}

function Section({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 mb-1">
        <Icon size={14} style={{ color: T.text2 }} />
        <span className="text-sm font-medium">{title}</span>
      </div>
      {children}
    </div>
  )
}

/** Kokoro v1.0 English voices: a/b = American/British, f/m = female/male. */
const KOKORO_VOICES = [
  'af_heart', 'af_bella', 'af_nicole', 'af_sarah', 'af_sky', 'af_nova', 'af_river', 'af_jessica', 'af_kore', 'af_aoede', 'af_alloy',
  'am_michael', 'am_fenrir', 'am_puck', 'am_adam', 'am_echo', 'am_eric', 'am_liam', 'am_onyx',
  'bf_emma', 'bf_isabella', 'bf_alice', 'bf_lily', 'bm_george', 'bm_fable', 'bm_daniel', 'bm_lewis'
]
const kokoroLabel = (id: string): string => {
  const [tag, name] = id.split('_')
  const who = { af: 'US female', am: 'US male', bf: 'UK female', bm: 'UK male' }[tag ?? ''] ?? tag
  return name ? `${name[0]!.toUpperCase()}${name.slice(1)} · ${who}` : id
}

const SHOWN = 6

const ago = (t: number, now: number): string => {
  if (!t) return 'never'
  const m = Math.round((now - t) / 60_000)
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`
}

/** The ranking behind the automatic Edge route: fastest first, direct always shown, the route in use highlighted. */
export function RouteTable({ rows, current, onUse }: { rows: ProxyRank[]; current: string; onUse?: (url: string) => void }) {
  const top = rows.slice(0, SHOWN)
  const direct = rows.find((r) => !r.url)
  if (direct && !top.includes(direct)) top.push(direct)
  const dead = rows.filter((r) => r.firstMs === null).length
  return (
    <div className="pb-3 flex flex-col gap-1" data-testid="route-table">
      {top.map((r) => {
        const inUse = r.url === current
        return (
          <div key={r.url || 'direct'} className="flex items-center gap-3 text-xs" style={{ fontFamily: T.mono, color: inUse ? T.cyan : T.text }}>
            <span style={{ width: 22, color: T.text3, textAlign: 'right' }}>{rows.indexOf(r) + 1}</span>
            <span style={{ width: 170 }}>{r.url ? r.label : 'direct (your connection)'}</span>
            <span className="truncate" title={r.country} style={{ width: 130, whiteSpace: 'nowrap', color: inUse ? T.cyan : T.text2 }}>{r.country ?? ''}</span>
            <span style={{ width: 70, textAlign: 'right' }}>{r.firstMs === null ? 'failed' : `${r.firstMs} ms`}</span>
            <span style={{ width: 70, color: T.text3 }}>{inUse ? 'in use' : r.ok < r.runs ? `${r.ok}/${r.runs} ok` : ''}</span>
            {onUse && r.url && r.firstMs !== null && !inUse && (
              <Btn small onClick={() => onUse(r.url)}>
                Use
              </Btn>
            )}
          </div>
        )
      })}
      {rows.length > top.length && (
        <span className="text-xs" style={{ color: T.text3 }}>
          {rows.length - top.length} more{dead ? `, ${dead} failed` : ''}.
        </span>
      )}
    </div>
  )
}

export function VoiceOutput() {
  const settings = useStore((s) => s.settings)
  const updateSettings = useStore((s) => s.updateSettings)
  const services = useStore((s) => s.services)
  const keys = useStore((s) => s.keys)
  const keyed = useMemo(() => keyedProviders(keys), [keys])
  const [voices, setVoices] = useState<VoiceInfo[]>([])
  const [catalog, setCatalog] = useState<TtsCatalog | null>(null)
  const [previewing, setPreviewing] = useState<string | null>(null)
  const [proxyDraft, setProxyDraft] = useState<string | null>(null)
  const [listDraft, setListDraft] = useState<string | null>(null)
  const [showRanking, setShowRanking] = useState(false)
  const route = useStore((s) => s.edgeRoute)
  const [now, setNow] = useState(() => Date.now())
  const engine = settings?.voice.engine ?? 'edge'
  const cloud: CloudTtsProvider | null = isCloudTts(engine) ? engine : null

  useEffect(() => {
    window.api.speak
      .voices()
      .then((v) => {
        const en = v.filter((x) => x.locale.startsWith('en-'))
        en.sort((a, b) => {
          const aAva = /Ava/.test(a.shortName) ? 0 : 1
          const bAva = /Ava/.test(b.shortName) ? 0 : 1
          return aAva - bAva || a.locale.localeCompare(b.locale) || a.name.localeCompare(b.name)
        })
        setVoices(en)
      })
      .catch(() => setVoices([]))
  }, [])

  useEffect(() => {
    window.api.speak
      .route()
      .then((edgeRoute) => useStore.setState({ edgeRoute }))
      .catch(() => undefined)
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (!cloud) {
      setCatalog(null)
      return
    }
    let live = true
    setCatalog(null)
    window.api.speak
      .catalog(cloud)
      .then((c) => live && setCatalog(c))
      .catch(() => live && setCatalog(null))
    return () => {
      live = false
    }
  }, [cloud, keys])

  if (!settings) return null
  const v = settings.voice
  const preview = async (name: string, on: TtsEngineId) => {
    setPreviewing(name)
    try {
      await window.api.speak.preview(name, on)
    } finally {
      setPreviewing(null)
    }
  }
  const tts = services.tts
  const info = cloud ? TTS_PROVIDERS[cloud] : null
  const choice = cloud ? cloudChoice(v, cloud) : null
  const setCloud = (patch: Partial<CloudVoiceChoice>) => {
    if (!cloud) return
    void updateSettings({ voice: { ...v, cloud: { ...v.cloud, [cloud]: { ...v.cloud?.[cloud], ...patch } } } })
  }
  const models = catalog?.models?.length ? catalog.models : (info?.models ?? [])
  const cloudVoices = catalog?.voices?.length ? catalog.voices : (info?.voices ?? [])
  const modelOptions = models.map((m) => ({ id: m.id, label: m.note ? `${m.label} · ${m.note}` : m.label }))
  if (choice && !models.some((m) => m.id === choice.model)) modelOptions.unshift({ id: choice.model, label: choice.model })
  const voiceOptions = cloudVoices.map((x) => ({ id: x.shortName, label: x.name === x.shortName ? x.name : `${x.name} · ${x.gender || x.locale}` }))
  if (choice && !cloudVoices.some((x) => x.shortName === choice.voice)) voiceOptions.unshift({ id: choice.voice, label: `custom · ${choice.voice.slice(0, 24)}` })
  const takesTags = cloud && choice ? modelTakesTags(cloud, choice.model) : false
  // the account's own list loaded and the saved voice id isn't in it (a voice from another account)
  const voiceMissing = !!(cloud && choice?.voice && catalog?.voices?.length && !catalog.error && !catalog.voices.some((x) => x.shortName === choice.voice))
  const engineOptions = [
    { id: 'edge', label: TTS_ENGINE_LABELS.edge },
    { id: 'kokoro', label: TTS_ENGINE_LABELS.kokoro },
    { id: 'system', label: TTS_ENGINE_LABELS.system },
    ...CLOUD_TTS_PROVIDERS.map((p) => {
      const locked = keyed !== null && !keyed.has(p)
      return { id: p, label: `${TTS_PROVIDERS[p].label}${locked ? ' · no key' : ''}`, disabled: locked }
    })
  ]
  const commitProxy = () => {
    if (proxyDraft !== null && proxyDraft.trim() !== v.proxy.url) void updateSettings({ voice: { ...v, proxy: { ...v.proxy, url: proxyDraft.trim() } } })
    setProxyDraft(null)
  }
  const list = listDraft ?? v.proxy.list ?? ''
  const proxyCount = list.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#')).length
  const commitList = () => {
    if (listDraft !== null && listDraft !== v.proxy.list) void updateSettings({ voice: { ...v, proxy: { ...v.proxy, list: listDraft } } })
    setListDraft(null)
  }
  const auto = v.proxy.auto !== false
  const testAll = async () => {
    commitList()
    try {
      useStore.setState({ edgeRoute: await window.api.speak.testRoutes() })
      setShowRanking(true)
    } catch {
      /* the state event carries the outcome */
    }
  }
  const routeLine = !route
    ? ''
    : route.testing
      ? 'Testing routes…'
      : route.proxies === 0
        ? 'No proxies yet: Edge goes direct.'
        : `${route.url ? `Now through ${route.label}${route.country ? ` (${route.country})` : ''}` : 'Now direct'}${route.firstMs != null ? ` · ${route.firstMs} ms` : ''}${route.url ? ` (direct ${route.directMs != null ? `${route.directMs} ms` : 'failed'})` : ''} · checked ${ago(route.checkedAt, now)} · ${route.proxies} proxies, all tested ${ago(route.rankedAt, now)}`
  const kokoroState = engine === 'kokoro' ? tts?.state : undefined
  const kokoroLoading = kokoroState === 'starting' && !!tts?.detail?.includes('loading')
  return (
    <Section icon={Headphones} title="Voice output">
      <Card pad={0}>
        <div className="px-4">
          <Row label="Engine" sub={ENGINE_SUB[engine]}>
            <span className="inline-flex items-center gap-2 text-xs" style={{ color: T.text2 }}>
              <Dot color={serviceColor(tts?.state)} />
              <span style={{ color: T.text3 }}>{tts?.detail ?? serviceLabel(tts?.state)}</span>
              <Select value={engine} width={150} onChange={(id) => void updateSettings({ voice: { ...v, engine: id as TtsEngineId } })} options={engineOptions} />
            </span>
          </Row>
          {cloud && info && choice && (
            <>
              <Row label="Model" sub={catalog?.error ? `Couldn't list from ${info.label}: ${catalog.error}` : 'The provider’s models that can speak.'}>
                <Select value={choice.model} width={230} onChange={(model) => setCloud({ model })} options={modelOptions} />
              </Row>
              <Row
                label="Voice"
                sub={
                  voiceMissing ? (
                    <span style={{ color: T.red }}>This voice isn't on the account this {info.label} key belongs to, so every sentence would fail. Pick one below, or put the owning account's key in Settings &gt; Providers or .env.</span>
                  ) : catalog && !catalog.error ? (
                    `${cloudVoices.length} listed; your own voices first.`
                  ) : (
                    info.voiceHint
                  )
                }
              >
                <span className="inline-flex items-center gap-2">
                  <span
                    className="inline-flex items-center gap-1 text-xs"
                    style={{ color: previewing === choice.voice ? T.cyan : T.text3, cursor: 'pointer' }}
                    onClick={() => void preview(choice.voice, cloud)}
                    role="button"
                    aria-label="Preview voice"
                  >
                    <Play size={11} /> preview
                  </span>
                  <Select value={choice.voice} width={230} onChange={(voice) => setCloud({ voice })} options={voiceOptions} />
                </span>
              </Row>
              <Row label="Voice id" sub={info.voiceHint}>
                <TextInput mono value={v.cloud?.[cloud]?.voice ?? ''} onChange={(voice) => setCloud({ voice })} placeholder={info.defaultVoice} style={{ width: 300 }} />
              </Row>
              {cloud === 'qwen' && (
                <Row label="Delivery instruction" sub="Free text sent with every sentence, e.g. “warm, unhurried, a little amused”.">
                  <TextInput value={choice.instruction} onChange={(instruction) => setCloud({ instruction })} placeholder="none" style={{ width: 300 }} />
                </Row>
              )}
              {info.tags && (
                <Row
                  label="Expressive cues"
                  sub={
                    takesTags
                      ? `Lets the model write cues like ${info.tags.open}${info.tags.cues[0]}${info.tags.close} where they fit. ${info.tags.note}`
                      : 'This model reads cues aloud, so they are removed before speaking; pick a model marked as understanding cues to use them.'
                  }
                >
                  <Toggle on={v.expressive} onChange={(expressive) => void updateSettings({ voice: { ...v, expressive } })} />
                </Row>
              )}
            </>
          )}
          {engine === 'kokoro' && (
            <Row
              label="Kokoro"
              sub={
                kokoroState === 'ready'
                  ? 'Loaded on this machine.'
                  : kokoroState === 'error'
                    ? (tts?.detail ?? 'Failed to load.')
                    : 'Loading takes 30 to 60 seconds. Edge speaks until it is ready, then replies switch to Kokoro by themselves.'
              }
            >
              <span className="inline-flex items-center gap-2 text-xs" style={{ color: kokoroState === 'ready' ? T.green : kokoroState === 'error' ? T.red : T.amber }}>
                <Dot color={serviceColor(kokoroState)} />
                {kokoroState === 'ready' ? 'Ready' : kokoroState === 'error' ? 'Failed' : kokoroLoading ? <span className="va-pulse">Loading…</span> : 'Not loaded'}
                {kokoroState !== 'ready' && !kokoroLoading && (
                  <Btn small onClick={() => void window.api.speak.startKokoro()}>
                    {kokoroState === 'error' ? 'Retry' : 'Load now'}
                  </Btn>
                )}
              </span>
            </Row>
          )}
          {engine === 'kokoro' && (
            <Row label="Kokoro voice" sub="Changes take effect from the next sentence. Preview plays it once Kokoro is loaded.">
              <span className="inline-flex items-center gap-2">
                <span
                  className="inline-flex items-center gap-1 text-xs"
                  style={{ color: previewing === v.kokoroVoice ? T.cyan : T.text3, cursor: kokoroState === 'ready' ? 'pointer' : 'default', opacity: kokoroState === 'ready' ? 1 : 0.5 }}
                  onClick={() => kokoroState === 'ready' && void preview(v.kokoroVoice, 'kokoro')}
                  role="button"
                  aria-label="Preview Kokoro voice"
                  title={kokoroState === 'ready' ? 'Hear this voice' : 'Available once Kokoro is loaded'}
                >
                  <Play size={11} /> preview
                </span>
                <Select
                  value={v.kokoroVoice}
                  width={170}
                  onChange={(kokoroVoice) => void updateSettings({ voice: { ...v, kokoroVoice } })}
                  options={(KOKORO_VOICES.includes(v.kokoroVoice) ? KOKORO_VOICES : [v.kokoroVoice, ...KOKORO_VOICES]).map((id) => ({ id, label: kokoroLabel(id) }))}
                />
              </span>
            </Row>
          )}
          <Row label="Rate" sub={`${v.rate > 0 ? '+' : ''}${Math.round(v.rate * 100)}%`}>
            <input type="range" min={-0.5} max={0.5} step={0.05} value={v.rate} onChange={(e) => void updateSettings({ voice: { ...v, rate: Number(e.target.value) } })} />
          </Row>
          {(engine === 'edge' || engine === 'qwen') && (
            <Row label="Pitch" sub={`${v.pitch > 0 ? '+' : ''}${Math.round(v.pitch)}Hz`}>
              <input type="range" min={-50} max={50} step={5} value={v.pitch} onChange={(e) => void updateSettings({ voice: { ...v, pitch: Number(e.target.value) } })} />
            </Row>
          )}
          <Row
            label="Proxy"
            sub={
              auto && route?.proxies
                ? 'http://user:pass@host:port. For the hosted voices (Hosted toggle); Edge picks its own route while Automatic is on.'
                : 'http://user:pass@host:port. Microsoft throttles the free Edge voice per IP address; a proxy gets around it. The hosted voices are quick direct, so leave them off unless they are blocked.'
            }
          >
            <span className="inline-flex items-center gap-3 text-xs" style={{ color: T.text2 }}>
              <TextInput
                mono
                type="password"
                value={proxyDraft ?? v.proxy.url}
                onChange={setProxyDraft}
                placeholder="none"
                style={{ width: 220 }}
                onKeyDown={(e) => e.key === 'Enter' && commitProxy()}
                onBlur={commitProxy}
              />
              <label className="inline-flex items-center gap-1.5" style={{ opacity: auto && route?.proxies ? 0.45 : 1 }}>
                Edge <Toggle on={v.proxy.edge} onChange={(edge) => void updateSettings({ voice: { ...v, proxy: { ...v.proxy, edge } } })} />
              </label>
              <label className="inline-flex items-center gap-1.5">
                Hosted <Toggle on={v.proxy.cloud} onChange={(c) => void updateSettings({ voice: { ...v, proxy: { ...v.proxy, cloud: c } } })} />
              </label>
            </span>
          </Row>
          <Row
            label="Edge route"
            sub={
              auto
                ? 'Automatic: your own connection while Edge answers quickly, the fastest of your proxies when Microsoft throttles it. Re-checks when Edge slows down or fails, and tests the whole list once a day.'
                : 'Off: Edge uses the Proxy above when its Edge toggle is on, else your own connection.'
            }
          >
            <span className="inline-flex items-center gap-3 text-xs" style={{ color: T.text2 }}>
              <label className="inline-flex items-center gap-1.5">
                Automatic <Toggle on={auto} onChange={(on) => void updateSettings({ voice: { ...v, proxy: { ...v.proxy, auto: on } } })} />
              </label>
              <Btn small icon={Gauge} onClick={() => void testAll()} disabled={!!route?.testing || (proxyCount === 0 && !route?.proxies)}>
                {route?.testing ? 'Testing…' : 'Test all'}
              </Btn>
            </span>
          </Row>
          {route && (
            <div className="pb-2 flex flex-col gap-1 text-xs" data-testid="route-status">
              <span style={{ color: route.testing ? T.amber : T.text2 }}>{routeLine}</span>
              {route.note && !route.testing && (route.proxies === 0 || /^Couldn't/.test(route.note)) && <span style={{ color: T.text3 }}>{route.note}</span>}
              {route.rows.length > 1 && (
                <button type="button" onClick={() => setShowRanking((x) => !x)} className="self-start" style={{ color: T.cyan, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
                  {showRanking ? 'Hide ranking' : 'Show ranking'}
                </button>
              )}
            </div>
          )}
          {route && showRanking && (
            <RouteTable
              rows={route.rows}
              current={auto ? route.url : v.proxy.edge ? v.proxy.url : ''}
              onUse={auto ? undefined : (url) => void updateSettings({ voice: { ...v, proxy: { ...v.proxy, url, edge: true } } })}
            />
          )}
          <Row label="Proxy list" sub="One per line: host:port:user:pass or a URL. PROXY_LIST_URL in .env (a Webshare download link) adds the list it returns, fetched at most hourly.">
            <textarea
              aria-label="Proxy list"
              value={list}
              onChange={(e) => setListDraft(e.target.value)}
              onBlur={commitList}
              rows={2}
              spellCheck={false}
              placeholder="203.0.113.10:8080:user:pass"
              className="rounded-lg p-2 text-xs resize-y"
              // the lines carry passwords: hidden like the URL field unless you are editing them
              style={{ width: 300, background: T.bg, color: T.text, border: `1px solid ${T.border}`, fontFamily: T.mono, ...(listDraft === null ? ({ WebkitTextSecurity: 'disc' } as CSSProperties) : {}) }}
            />
          </Row>
        </div>
        {engine === 'edge' && (
          <div className="px-4 py-3 flex flex-col gap-1.5">
            <span className="text-xs font-medium" style={{ color: T.text3 }}>
              Voice
            </span>
            {voices.length === 0 && (
              <span className="text-xs" style={{ color: T.text3 }}>
                Voice list unavailable (offline?). Current: {v.voice}
              </span>
            )}
            {voices.map((voice) => {
              const selected = v.voice === voice.shortName
              const isDefault = voice.shortName === 'en-US-AvaNeural'
              return (
                <button
                  key={voice.shortName}
                  onClick={() => void updateSettings({ voice: { ...v, voice: voice.shortName } })}
                  className="flex items-center gap-3 rounded-lg px-3 py-2 text-left"
                  style={{ background: selected ? T.raised : 'transparent', border: `1px solid ${selected ? T.cyanBorder : 'transparent'}`, cursor: 'pointer' }}
                >
                  <span style={{ width: 14, color: T.cyan }}>{selected ? <Check size={13} /> : null}</span>
                  <span className="text-sm" style={{ width: 110 }}>
                    {voice.name}
                  </span>
                  <span className="text-xs" style={{ color: T.text3, fontFamily: T.mono, width: 50 }}>
                    {voice.locale}
                  </span>
                  <span className="text-xs flex-1" style={{ color: T.text2 }}>
                    {isDefault ? 'Default · warm, quick' : voice.gender}
                  </span>
                  <span
                    className="inline-flex items-center gap-1 text-xs"
                    style={{ color: previewing === voice.shortName ? T.cyan : T.text3, cursor: 'pointer' }}
                    onClick={(e) => {
                      e.stopPropagation()
                      void preview(voice.shortName, 'edge')
                    }}
                  >
                    <Play size={11} /> preview
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </Card>
    </Section>
  )
}
