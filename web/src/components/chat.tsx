'use client';
// Chat UI for the assistant. Conversations are saved per account: the rail lists them, opening one
// loads it in place, and every new question goes to the open conversation so the model sees what came
// before. Motion: the question rises, three dots while the server answers, the answer appears word
// by word with a caret, evidence chips pop in.
import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { Mascot, MASCOT_POSTER, type MascotState } from './mascot';
import Link from 'next/link';
import { ArrowUp, Database, Link2, Languages, Download, SquarePen, Trash2, PanelLeftClose, PanelLeftOpen, Crosshair, X } from 'lucide-react';
import type { Reply } from '@/lib/assistant';
import type { Conversation, ConversationInfo } from '@/lib/conversations';
import type { Selection } from '@/lib/selection';
import { ReportPreview } from './report-preview';
import { fmtStamp } from '@/lib/format';
import { useT } from './i18n';

type Msg = { id: number; role: 'user'; text: string; page?: { title: string; href: string }; selection?: string[] } | { id: number; role: 'assistant'; reply: Reply; shown: number; total: number };
const reduced = () => typeof window !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const wordsOf = (r: Reply) => r.text.join(' ').split(/\s+/).length;

/** Keep ids (MER-6434, INC-6434-1111) on one line. */
const ID = /((?:MER|INC|ADV)-[\w-]*\d)/;
const ids = (p: string) => p.split(ID).map((part, i) => (i % 2 ? <span key={i} className="nowrap">{part}</span> : part));

/** Reveal the first `n` words across paragraphs. */
function reveal(text: string[], n: number) {
  const out: string[] = [];
  let left = n;
  for (const p of text) {
    if (left <= 0) break;
    const w = p.split(/\s+/);
    out.push(w.slice(0, left).join(' '));
    left -= w.length;
  }
  return out;
}

let seq = 1;
const toMsgs = (c: Conversation | null): Msg[] => (c?.turns ?? []).map((t) => (t.role === 'user'
  ? { id: seq++, role: 'user', text: t.text, page: t.page, selection: t.selection?.map((x) => x.label) }
  : { id: seq++, role: 'assistant', reply: t.reply, shown: wordsOf(t.reply), total: wordsOf(t.reply) }));
const setUrl = (id: string | null) => window.history.replaceState(null, '', id ? `/assistant?c=${id}` : '/assistant');

const RAIL_COOKIE = 'pai-rail';
const narrow = () => matchMedia('(max-width: 900px)').matches; // the rail is a drawer there

/** `variant="dock"`: the compact assistant on every page (no history rail, no URL sync); `page` is
 *  the page the questions are asked from, so the model can read what is on it. */
export function Chat({ initial, examples, conversations, conversation, folded: foldedAtLoad = false, variant = 'page', page, onConversation, emptyTitle, attachments = [], onRemoveAttachment, onSent, onPick, picking = false, onReply }: {
  initial?: string; examples: { en: string[]; fr: string[] }; conversations: ConversationInfo[]; conversation: Conversation | null; folded?: boolean;
  variant?: 'page' | 'dock'; page?: { path: string; search: string }; onConversation?: (id: string) => void; emptyTitle?: string;
  /** parts of the page selected by the user, sent with the next question */
  attachments?: Selection[]; onRemoveAttachment?: (i: number) => void; onSent?: () => void; onPick?: () => void; picking?: boolean;
  onReply?: (r: Reply) => void;
}) {
  const dock = variant === 'dock', t = useT();
  const [list, setList] = useState(conversations);
  const [convId, setConvId] = useState<string | null>(conversation?.id ?? null);
  const [msgs, setMsgs] = useState<Msg[]>(() => toMsgs(conversation));
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(false);       // drawer, narrow screens
  const [folded, setFolded] = useState(foldedAtLoad);     // folded to the left, wide screens (remembered in a cookie)
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // is the language model reachable? (checked on open and refreshed by every answer)
  const [modelState, setModelState] = useState<'online' | 'offline' | 'off' | null>(null);
  // the mascot: a one-shot reaction (wave, success, error) wins, then what the chat is doing; asleep after 90 s idle
  const [flash, setFlash] = useState<MascotState | null>('wave');
  const [asleep, setAsleep] = useState(false);
  const checkModel = () => fetch('/api/v1/assistant/status').then((r) => r.json()).then((d) => setModelState(d.model ?? null)).catch(() => {});
  useEffect(() => { checkModel(); }, []);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const asked = useRef(false);

  // scroll the conversation itself, never the page behind it (the dock floats over other pages)
  useEffect(() => { const el = scrollRef.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: reduced() ? 'auto' : 'smooth' }); }, [msgs, busy]);

  async function ask(q: string) {
    const sel = attachments;
    const question = q.trim() || (sel.length ? t('chat.explainSelection') : '');
    if (!question || busy) return;
    setError(null); setDraft(''); setBusy(true);
    setMsgs((m) => [...m, { id: seq++, role: 'user', text: question, selection: sel.map((x) => x.label) }]);
    onSent?.();
    const started = Date.now();
    try {
      const res = await fetch('/api/v1/assistant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question, conversation_id: convId, ...(page ? { page } : {}), ...(sel.length ? { selection: sel } : {}) }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message ?? t('chat.failed'));
      await new Promise((r) => setTimeout(r, Math.max(0, 550 - (Date.now() - started)))); // let the typing dots read as "thinking"
      const { conversation: saved, page: askedFrom, ...reply } = data as Reply & { conversation: { id: string; title: string; updated: string }; page: { title: string; href: string } | null };
      if (askedFrom) setMsgs((m) => m.map((x, i) => (i === m.length - 1 && x.role === 'user' ? { ...x, page: askedFrom } : x)));
      if (saved) {
        setConvId(saved.id);
        onConversation?.(saved.id);
        if (saved.id !== convId && !dock) setUrl(saved.id);
        setList((l) => [{ id: saved.id, title: saved.title, updated: saved.updated, questions: (l.find((x) => x.id === saved.id)?.questions ?? 0) + 1 }, ...l.filter((x) => x.id !== saved.id)]);
      }
      onReply?.(reply);
      if (reply.model) setModelState(reply.model);
      const id = seq++, total = wordsOf(reply);
      setMsgs((m) => [...m, { id, role: 'assistant', reply, shown: reduced() ? total : 0, total }]);
      if (!reduced()) {
        const timer = setInterval(() => setMsgs((m) => m.map((x) => {
          if (x.id !== id || x.role !== 'assistant') return x;
          if (x.shown >= x.total) { clearInterval(timer); return x; }
          return { ...x, shown: Math.min(x.total, x.shown + 2) };
        })), 28);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('chat.failed'));
      setFlash('error');
    } finally {
      setBusy(false);
    }
  }

  function newChat() {
    if (busy) return;
    setConvId(null); setMsgs([]); setError(null); setRailOpen(false); setUrl(null);
    inputRef.current?.focus();
  }

  function fold(next: boolean) {
    if (narrow()) { setRailOpen(!next); return; }
    setFolded(next);
    document.cookie = `${RAIL_COOKIE}=${next ? 'folded' : 'open'}; path=/; max-age=31536000; samesite=lax`;
  }

  async function open(id: string) {
    if (busy || id === convId) { setRailOpen(false); return; }
    setLoading(true); setError(null); setRailOpen(false);
    try {
      const res = await fetch(`/api/v1/assistant/conversations/${id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message ?? t('chat.openFailed'));
      setConvId(id); setMsgs(toMsgs(data)); setUrl(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('chat.openFailed'));
      setList((l) => l.filter((x) => x.id !== id));
    } finally {
      setLoading(false);
    }
  }

  async function remove(id: string) {
    if (confirmDel !== id) { setConfirmDel(id); return; }
    setConfirmDel(null);
    const res = await fetch(`/api/v1/assistant/conversations/${id}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) { setError(t('chat.deleteFailed')); return; }
    setList((l) => l.filter((x) => x.id !== id));
    if (id === convId) newChat();
  }

  useEffect(() => { if (initial && !asked.current) { asked.current = true; ask(initial); } });

  const empty = !msgs.length && !busy && !loading;
  const streaming = msgs.some((m) => m.role === 'assistant' && m.shown < m.total);
  const wasStreaming = useRef(false);
  useEffect(() => {   // an answer finished revealing: a short "success" reaction
    const done = wasStreaming.current && !streaming;
    wasStreaming.current = streaming;
    if (!done) return;
    const id = setTimeout(() => setFlash('success'), 0);
    return () => clearTimeout(id);
  }, [streaming]);
  useEffect(() => { if (!flash) return; const id = setTimeout(() => setFlash(null), flash === 'wave' ? 1500 : 1400); return () => clearTimeout(id); }, [flash]);
  useEffect(() => {   // any activity wakes it; 90 s without any puts it to sleep
    const wake = setTimeout(() => setAsleep(false), 0), sleep = setTimeout(() => setAsleep(true), 90_000);
    return () => { clearTimeout(wake); clearTimeout(sleep); };
  }, [draft, msgs.length, busy, streaming]);
  const mascot: MascotState = flash ?? (busy || loading ? 'thinking' : streaming ? 'typing' : draft.trim() ? 'listening' : asleep ? 'sleeping' : 'idle');
  const grow = (el: HTMLTextAreaElement) => { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 200)}px`; };
  const when = (iso: string) => fmtStamp(iso, t.locale);
  return (
    <div className={`chat${dock ? ' dock' : ''}${railOpen ? ' rail-open' : ''}${folded ? ' rail-folded' : ''}`}>
      {!dock && <>
      <aside className="chat-rail" aria-label={t('chat.conversations')} inert={folded && !railOpen ? true : undefined}>
        <div className="rail-head">
          <button type="button" className="rail-new" onClick={newChat}><SquarePen aria-hidden />{t('chat.new')}</button>
          <button type="button" className="rail-fold" onClick={() => fold(true)} aria-label={t('chat.fold')} title={t('chat.fold')}><PanelLeftClose aria-hidden /></button>
        </div>
        <span className="rail-title">{t('incd.history')}</span>
        {list.length ? (
          <ul className="rail-list" onMouseLeave={() => setConfirmDel(null)}>
            {list.map((c) => (
              <li key={c.id} className={`rail-item${c.id === convId ? ' on' : ''}`}>
                <button type="button" className="rail-open" onClick={() => open(c.id)} title={`${c.title} · ${when(c.updated)} · ${t('chat.questions', { n: c.questions })}`} aria-current={c.id === convId ? 'true' : undefined} dir="auto">{c.title}</button>
                <button type="button" className={`rail-del${confirmDel === c.id ? ' confirm' : ''}`} onClick={() => remove(c.id)} aria-label={confirmDel === c.id ? t('chat.confirmDelete', { title: c.title }) : t('chat.delete', { title: c.title })}>
                  {confirmDel === c.id ? t('chat.deleteShort') : <Trash2 aria-hidden />}
                </button>
              </li>
            ))}
          </ul>
        ) : <p className="rail-empty">{t('chat.emptyRail')}</p>}
      </aside>
      <button type="button" className="rail-scrim" aria-label={t('chat.closeHistory')} onClick={() => setRailOpen(false)} />
      </>}

      <div className={`chat-main${empty ? ' is-empty' : ''}`}>
        {!dock && <div className="rail-toggle">
          <button type="button" onClick={() => fold(false)} aria-label={t('chat.showHistory')} title={t('chat.showHistory')}><PanelLeftOpen aria-hidden /></button>
          <button type="button" onClick={newChat} aria-label={t('chat.new')} title={t('chat.new')}><SquarePen aria-hidden /></button>
        </div>}
        <div className="chat-scroll" ref={scrollRef} aria-live="polite" aria-busy={loading}>
          <div className="chat-col">
            {empty && (
              <div className="chat-empty m-fade">
                <Mascot state={mascot} size={dock ? 104 : 150} className="mascot-hero" />
                <h2>{emptyTitle ?? t('chat.emptyTitle')}</h2>
                <p className="sr-only">{t('chat.facts')}</p>
                <div className="chat-facts" aria-hidden><span><Database />{t('chat.factData')}</span><span><Link2 />{t('chat.factEvidence')}</span><span><Languages />FR · EN · Darija</span></div>
              </div>
            )}
            {msgs.map((m) => m.role === 'user'
              ? <div key={m.id} className="msg-user m-rise">{m.selection?.length ? <div className="msg-sel">{m.selection.map((l, i) => <span key={i}><Crosshair aria-hidden />{l}</span>)}</div> : null}<p dir="auto">{m.text}</p>{m.page && !dock && <Link href={m.page.href} className="asked-from">{t('chat.askedOn', { page: m.page.title })}</Link>}</div>
              : (
                <div key={m.id} className={`msg-ai m-fade${m.reply.refused ? ' refused' : ''}`}>
                  <span className="ai-avatar" aria-hidden><Image src={MASCOT_POSTER} alt="" width={28} height={28} /></span>
                  <div className="ai-body">
                    {reveal(m.reply.text, m.shown).map((p, i, a) => <p key={i} dir="auto" className={i === a.length - 1 && m.shown < m.total ? 'm-caret' : ''}>{ids(p)}</p>)}
                    {m.shown >= m.total && m.reply.table && (
                      <div className="chat-table m-fade"><table className="stats">
                        <thead><tr>{m.reply.table.head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
                        <tbody>{m.reply.table.rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} dir="auto" className={j ? 'num' : ''}>{v}</td>)}</tr>)}</tbody>
                      </table></div>
                    )}
                    {m.shown >= m.total && m.reply.evidence.length > 0 && (
                      <div className="evidence">{m.reply.evidence.map((e, i) => {
                        const style = { '--delay': `${i * 70}ms` } as React.CSSProperties;
                        // files (PDF reports, CSV exports) download; pages open in the app
                        return e.href.startsWith('/api/')
                          ? <a key={e.href + i} href={e.href} className="dl m-pop" style={style}><Download aria-hidden />{e.label}</a>
                          : <Link key={e.href + i} href={e.href} className="m-pop" style={style}>{e.label}</Link>;
                      })}</div>
                    )}
                    {m.shown >= m.total && m.reply.report && <ReportPreview report={m.reply.report} compact={dock} />}
                    {m.shown >= m.total && m.reply.scope && <small className="scope">{m.reply.scope}</small>}
                    {m.shown >= m.total && m.reply.fallback && <small className="fallback-tag" title={t('chat.fallbackTitle')}>{t('chat.fallback')} · {m.reply.fallback === 'model_rejected' ? t('chat.fbRejected') : m.reply.fallback === 'model_off' ? t('chat.fbOff') : t('chat.fbOffline')}</small>}
                  </div>
                </div>
              ))}
            {(busy || loading) && <div className="msg-ai"><span className="ai-avatar" aria-hidden><Image src={MASCOT_POSTER} alt="" width={28} height={28} /></span><div className="ai-body typing" aria-label={loading ? t('common.loading') : t('chat.thinking')}><span className="m-typing"><span /><span /><span /></span></div></div>}
            {error && <p className="err" role="alert">{error}</p>}
          </div>
        </div>
        <div className="chat-dock">
          <div className="chat-col">
            {(modelState === 'offline' || modelState === 'off') && (
              <p className={`model-note ${modelState}`} role="status">
                <i aria-hidden />{modelState === 'offline' ? t('chat.modeOffline') : t('chat.modeOff')}
                {modelState === 'offline' && <button type="button" onClick={checkModel}>{t('common.retry')}</button>}
              </p>
            )}
            {attachments.length > 0 && (
              <div className="chat-attach" aria-label={t('chat.selected')}>
                {attachments.map((a, i) => (
                  <span key={i} className="attach-chip m-pop" title={a.tip ?? a.text ?? a.label}><Crosshair aria-hidden /><span dir="auto">{a.label}</span>
                    <button type="button" onClick={() => onRemoveAttachment?.(i)} aria-label={t('imp.removeFile', { name: a.label })}><X aria-hidden /></button></span>
                ))}
              </div>
            )}
            <form className="chat-input" onSubmit={(e) => { e.preventDefault(); ask(draft); }}>
              {!empty && <Mascot state={mascot} size={44} className="mascot-composer" />}
              {onPick && <button type="button" className={`pick-btn${picking ? ' on' : ''}`} onClick={onPick} aria-pressed={picking} aria-label={t('chat.pick')} title={t('chat.pick')}><Crosshair aria-hidden /></button>}
              <textarea ref={inputRef} dir="auto" value={draft} onChange={(e) => { setDraft(e.target.value); grow(e.target); }} rows={1} maxLength={500} placeholder={attachments.length ? t('chat.askSelection') : convId ? t('chat.followUp') : t('chat.ask')} aria-label={t('chat.yourQuestion')}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(draft); e.currentTarget.style.height = 'auto'; } }} />
              <button className="send" disabled={busy || (!draft.trim() && !attachments.length)} aria-label={t('chat.send')}><ArrowUp /></button>
            </form>
            {empty && <div className="suggest">{(t.locale === 'fr' ? examples.fr : examples.en).slice(0, 4).map((s) => <button key={s} onClick={() => ask(s)}>{s}</button>)}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
