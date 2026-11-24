/**
 * The code editor in the file viewer: CodeMirror with syntax colours for the file's type, line numbers,
 * folding, search (Ctrl+F), undo, and Ctrl+S to save. It is always dark, like the terminal views.
 */
import { useEffect, useRef } from 'react'
import { basicSetup } from 'codemirror'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { T, TERM } from '../../theme'
import { languageFor } from './languages'

export interface EditorStatus {
  line: number
  col: number
  lines: number
  /** Characters selected, 0 when there is only a cursor. */
  selected: number
}

const C = {
  keyword: '#C4A1FF',
  string: '#9ED99A',
  number: '#F2B36B',
  comment: '#6B7480',
  fn: '#7CC4FF',
  type: '#5FD6E8',
  tag: '#FF9580',
  attr: '#F2B36B',
  prop: '#D6DEE8',
  punct: '#8B96A3'
}

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: C.keyword },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: C.string },
  { tag: [t.number, t.bool, t.null, t.atom], color: C.number },
  { tag: [t.lineComment, t.blockComment, t.docComment, t.comment], color: C.comment, fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], color: C.fn },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: C.type },
  { tag: [t.tagName, t.angleBracket], color: C.tag },
  { tag: [t.attributeName], color: C.attr },
  { tag: [t.propertyName, t.definition(t.propertyName)], color: C.prop },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket, t.derefOperator], color: C.punct },
  { tag: [t.meta, t.processingInstruction, t.annotation], color: C.comment },
  { tag: [t.self, t.special(t.variableName)], color: C.tag },
  { tag: t.heading, color: TERM.bright, fontWeight: '700' },
  { tag: [t.link, t.url], color: C.fn, textDecoration: 'underline' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '700', color: TERM.bright },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.monospace, t.contentSeparator], color: C.string },
  { tag: t.quote, color: TERM.dim, fontStyle: 'italic' },
  { tag: t.inserted, color: C.string },
  { tag: t.deleted, color: C.tag },
  { tag: t.invalid, color: TERM.err }
])

const look = EditorView.theme(
  {
    '&': { height: '100%', fontSize: '12.5px', color: TERM.text, backgroundColor: TERM.bg },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: T.mono, lineHeight: '1.65', overflow: 'auto' },
    '.cm-content': { padding: '10px 0 40vh', caretColor: TERM.bright },
    '.cm-line': { padding: '0 16px 0 6px' },
    '.cm-gutters': { backgroundColor: TERM.bg, color: TERM.gutter, border: 'none', paddingLeft: '6px' },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 8px', minWidth: '34px' },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,.035)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: TERM.dim },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: TERM.bright, borderLeftWidth: '2px' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'rgba(124,196,255,.24)' },
    '.cm-selectionMatch': { backgroundColor: 'rgba(124,196,255,.13)' },
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'rgba(196,161,255,.22)', outline: '1px solid rgba(196,161,255,.45)' },
    '.cm-foldPlaceholder': { backgroundColor: 'rgba(255,255,255,.08)', border: 'none', color: TERM.dim, padding: '0 6px', borderRadius: '4px' },
    '.cm-foldGutter .cm-gutterElement': { color: TERM.gutter, cursor: 'pointer' },
    '.cm-searchMatch': { backgroundColor: 'rgba(242,179,107,.28)', outline: '1px solid rgba(242,179,107,.5)' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(242,179,107,.55)' },
    '.cm-panels': { backgroundColor: TERM.chrome, color: TERM.text, borderTop: `1px solid ${TERM.border}` },
    '.cm-panels.cm-panels-top': { borderBottom: `1px solid ${TERM.border}`, borderTop: 'none' },
    '.cm-search': { padding: '8px 10px', fontFamily: 'inherit', fontSize: '12px' },
    '.cm-textfield': { backgroundColor: TERM.bg, color: TERM.bright, border: `1px solid ${TERM.gutter}`, borderRadius: '6px', padding: '3px 7px' },
    '.cm-button': { backgroundImage: 'none', backgroundColor: 'rgba(255,255,255,.07)', color: TERM.text, border: `1px solid ${TERM.gutter}`, borderRadius: '6px', padding: '3px 9px' },
    '.cm-panel.cm-search [name=close]': { color: TERM.dim, fontSize: '16px', cursor: 'pointer' },
    '.cm-tooltip': { backgroundColor: TERM.chrome, color: TERM.text, border: `1px solid ${TERM.gutter}`, borderRadius: '8px', overflow: 'hidden' },
    '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'rgba(124,196,255,.2)', color: TERM.bright }
  },
  { dark: true }
)

export function CodeEditor({ path, value, readOnly = false, onChange, onSave, onStatus }: {
  path: string
  /** The text to show. A new value replaces the document only when it differs from what is in the editor. */
  value: string
  readOnly?: boolean
  onChange?: (text: string) => void
  onSave?: () => void
  onStatus?: (s: EditorStatus) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const cb = useRef({ onChange, onSave, onStatus })
  cb.current = { onChange, onSave, onStatus }
  const lang = useRef(new Compartment())
  const lock = useRef(new Compartment())
  /** True while a document swap from props is being applied, so it is not reported back as a user edit. */
  const applying = useRef(false)

  useEffect(() => {
    if (!host.current) return
    const report = (s: EditorState): void => {
      const head = s.selection.main.head
      const line = s.doc.lineAt(head)
      cb.current.onStatus?.({ line: line.number, col: head - line.from + 1, lines: s.doc.lines, selected: s.selection.main.to - s.selection.main.from })
    }
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          // before basicSetup, so Ctrl+S saves instead of reaching the browser
          keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { cb.current.onSave?.(); return true } }, indentWithTab]),
          basicSetup,
          look,
          syntaxHighlighting(highlight),
          EditorState.tabSize.of(2),
          lang.current.of([]),
          lock.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !applying.current) cb.current.onChange?.(u.state.doc.toString())
            if (u.docChanged || u.selectionSet) report(u.state)
          })
        ]
      })
    })
    view.current = v
    report(v.state)
    return () => {
      v.destroy()
      view.current = null
    }
    // one editor per mount; `value`, `path` and `readOnly` are applied by the effects below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // a different text from outside (another file, a reload from disk, a revert): swap the document
  useEffect(() => {
    const v = view.current
    if (!v || v.state.doc.toString() === value) return
    applying.current = true
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value }, selection: { anchor: 0 }, scrollIntoView: true })
    applying.current = false
  }, [value])

  useEffect(() => {
    let live = true
    const l = languageFor(path)
    const apply = (ext: unknown): void => {
      if (live) view.current?.dispatch({ effects: lang.current.reconfigure((ext ?? []) as never) })
    }
    if (!l) apply(null)
    else l.load().then(apply, () => apply(null))
    return () => {
      live = false
    }
  }, [path])

  useEffect(() => {
    view.current?.dispatch({ effects: lock.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]) })
  }, [readOnly])

  return <div ref={host} className="va-term h-full min-h-0" style={{ overflow: 'hidden' }} />
}

export default CodeEditor
