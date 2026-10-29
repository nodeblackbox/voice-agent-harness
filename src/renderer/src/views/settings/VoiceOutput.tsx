import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Check, Headphones, Play, type LucideIcon } from 'lucide-react'
import type { CloudTtsProvider, CloudVoiceChoice, TtsCatalog, TtsEngineId, VoiceInfo } from '@shared/types'
import { CLOUD_TTS_PROVIDERS, TTS_ENGINE_LABELS, TTS_PROVIDERS, cloudChoice, isCloudTts, modelTakesTags } from '@shared/tts'
import { T, serviceColor, serviceLabel } from '../../theme'
import { keyedProviders, useStore } from '../../state/store'
import { Card, Dot, Row, Select, TextInput, Toggle } from '../../components/primitives'

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
              <Row label="Voice" sub={catalog && !catalog.error ? `${cloudVoices.length} listed; your own voices first.` : info.voiceHint}>
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
            <Row label="Kokoro voice" sub="af_ = American female, am_ = male, bf_/bm_ = British.">
              <Select
                value={v.kokoroVoice}
                width={130}
                onChange={(kokoroVoice) => void updateSettings({ voice: { ...v, kokoroVoice } })}
                options={['af_heart', 'af_bella', 'af_nicole', 'am_michael', 'am_fenrir', 'bf_emma', 'bm_george'].map((id) => ({ id, label: id }))}
              />
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
          <Row label="Proxy" sub="http://user:pass@host:port. Microsoft throttles the free Edge voice per IP address; a proxy gets around it. The hosted voices are quick direct, so leave them off unless they are blocked.">
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
              <label className="inline-flex items-center gap-1.5">
                Edge <Toggle on={v.proxy.edge} onChange={(edge) => void updateSettings({ voice: { ...v, proxy: { ...v.proxy, edge } } })} />
              </label>
              <label className="inline-flex items-center gap-1.5">
                Hosted <Toggle on={v.proxy.cloud} onChange={(c) => void updateSettings({ voice: { ...v, proxy: { ...v.proxy, cloud: c } } })} />
              </label>
            </span>
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
