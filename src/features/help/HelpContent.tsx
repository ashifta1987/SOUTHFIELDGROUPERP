import { useState, type FormEvent, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { SCREENS } from '@/app/screens'
import { useAuth } from '@/auth/AuthProvider'
import { rowsOf, useApiRpc, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { RpcErrorBox } from '@/features/common/RpcErrorBox'
import { formatDate, formatTime } from '@/shared/format'
import { Button, Chip, ErrorRef, Field, Icon, SelectField, Skeleton, TextAreaField } from '@/ui'
import type { HelpRequest } from './events'

interface SearchRow {
  slug: string
  title: string
  snippet: string
  screen: string | null
  rule_code: string | null
}
interface HelpPage {
  slug: string
  title: string
  body: string
  screen: string | null
  rule_code: string | null
}
interface Explained {
  found: boolean
  ref?: string
  at?: string
  route?: string | null
  rpc?: string | null
  rule_code?: string | null
  message?: string | null
  page?: { slug: string; title: string; body: string } | null
}
type Report = ViewRow<'problem_reports'>
type Mode = 'home' | 'page' | 'report'

const SEARCH_LANGS = new Set(['en', 'ml', 'hi', 'bho'])

/** The reference screen for the current route (help pages are tagged with it). */
function useScreenFile(): string | null {
  const { pathname } = useLocation()
  return SCREENS.find((s) => s.route === pathname)?.file ?? null
}

/** Help bodies are short Markdown-like text: paragraphs, "- " lists and "#" headings. Rendered as text only. */
function HelpBody({ body }: { body: string }) {
  const blocks = body.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 14, color: 'var(--sf-text-2)' }}>
      {blocks.map((b, i) => {
        const lines = b.split('\n')
        if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
          return (
            <ul key={i} style={{ margin: 0, paddingLeft: 18 }}>
              {lines.map((l, j) => (
                <li key={j}>{l.replace(/^\s*[-*]\s+/, '')}</li>
              ))}
            </ul>
          )
        }
        if (/^#{1,6}\s/.test(b)) return <strong key={i}>{b.replace(/^#{1,6}\s+/, '')}</strong>
        return (
          <p key={i} style={{ margin: 0 }}>
            {b.replace(/\*\*/g, '')}
          </p>
        )
      })}
    </div>
  )
}

function Checked({ children }: { children: ReactNode }) {
  return (
    <span className="muted" style={{ fontSize: 12.5, display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <Icon name="check" size={12} />
      {children}
    </span>
  )
}

function reportStatus(status: string, t: (k: string) => string) {
  if (status === 'closed') return <Chip tone="success" icon="check">{t('helpPanel.status.closed')}</Chip>
  if (status === 'in_progress') return <Chip tone="info" icon="clock">{t('helpPanel.status.in_progress')}</Chip>
  return <Chip tone="signal" icon="clock">{t('helpPanel.status.open')}</Chip>
}

/**
 * Southfield Help v1 (§HELP-3, §HELP-9): search the help pages, open a page, explain an error reference (the user's own
 * errors only) and file a problem report. Everything runs with the user's own rights through read RPCs; nothing here
 * changes business data. The AI assistant (help-agent Edge Function) is added when the owner chooses the model provider.
 */
export function HelpContent({ request }: { request: HelpRequest }) {
  const { t, i18n } = useTranslation()
  const { profile, session } = useAuth()
  const screen = useScreenFile()
  const lang = SEARCH_LANGS.has(i18n.resolvedLanguage ?? 'en') ? (i18n.resolvedLanguage ?? 'en') : 'en'
  const isAdmin = profile?.view === 'all'
  const myId = session?.user.id

  const [mode, setMode] = useState<Mode>(request.page ? 'page' : 'home')
  const [slug, setSlug] = useState<string | null>(request.page ?? null)
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [errorRef, setErrorRef] = useState(request.errorCode ?? '')
  const [refInput, setRefInput] = useState(request.errorCode ?? '')
  const [showRefInput, setShowRefInput] = useState(false)
  const [what, setWhat] = useState('')
  const [filed, setFiled] = useState<{ code: string } | null>(null)
  const [accessNote, setAccessNote] = useState(false)
  const [notice, setNotice] = useState(() => localStorage.getItem('sf.help.notice') !== 'seen')

  const search = useApiRpc<SearchRow[]>('search_help', { p_query: submitted || null, p_screen: screen, p_language: lang })
  const results = search.data?.status === 'ready' ? (search.data.data ?? []) : []
  const searchEn = useApiRpc<SearchRow[]>('search_help', { p_query: submitted || null, p_screen: screen, p_language: 'en' }, lang !== 'en' && search.data?.status === 'ready' && results.length === 0)
  const shown = results.length ? results : searchEn.data?.status === 'ready' ? (searchEn.data.data ?? []) : []

  const page = useApiRpc<HelpPage | null>('help_page', { p_slug: slug, p_language: lang }, Boolean(slug) && mode === 'page')
  const pageData = page.data?.status === 'ready' ? page.data.data : null

  const explained = useApiRpc<Explained>('explain_error', { p_ref: errorRef }, Boolean(errorRef))
  const ex = explained.data?.status === 'ready' ? explained.data.data : null

  const reports = useApiView('problem_reports', { order: 'created_at', ascending: false, limit: 30 })
  const allReports = rowsOf(reports)
  const mine = allReports.filter((r) => r.user_id === myId).slice(0, 5)
  const toAnswer = isAdmin ? allReports.filter((r) => r.status !== 'closed' && r.user_id !== myId) : []

  const create = useApiMutation<{ p: { screen: string | null; error_ref: string | null; what_happened: string } }, { id: string; code: string }>('create_problem_report', [['api', 'problem_reports']])

  function onSearch(e: FormEvent) {
    e.preventDefault()
    setSubmitted(query.trim())
    setMode('home')
  }
  function openPage(s: string) {
    setSlug(s)
    setMode('page')
  }
  function fileReport(e: FormEvent) {
    e.preventDefault()
    create.mutate(
      { p: { screen: screen ?? window.location.pathname, error_ref: errorRef || null, what_happened: what.trim() } },
      {
        onSuccess: (r) => {
          setFiled({ code: r.code })
          setWhat('')
        },
      },
    )
  }
  function dismissNotice() {
    localStorage.setItem('sf.help.notice', 'seen')
    setNotice(false)
  }

  const createMsg = create.error?.rule === 'help.describe' ? <ErrorRef message={t('helpPanel.rules.describe')} refId={create.error.ref} /> : <RpcErrorBox error={create.error} />

  return (
    <>
      {notice ? (
        <div className="sf-phone-note" role="note" style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
          <span>{t('helpPanel.notice')}</span>
          <Button size="sm" onClick={dismissNotice} style={{ alignSelf: 'flex-start' }}>
            {t('helpPanel.noticeOk')}
          </Button>
        </div>
      ) : null}

      <p style={{ margin: 0, color: 'var(--sf-text-2)', fontSize: 14 }}>{t('helpPanel.intro')}</p>

      <div className="sf-row" style={{ flexWrap: 'wrap', gap: 6 }}>
        <Button size="sm" onClick={() => { setSubmitted(''); setQuery(''); setMode('home') }}>
          {t('helpPanel.chipScreen')}
        </Button>
        <Button size="sm" onClick={() => { setShowRefInput(true); setMode('home') }}>
          {t('helpPanel.chipBlocked')}
        </Button>
        <Button size="sm" onClick={() => { setFiled(null); setMode('report') }}>
          {t('helpPanel.chipReport')}
        </Button>
        <Button size="sm" onClick={() => setAccessNote((v) => !v)} aria-expanded={accessNote}>
          {t('helpPanel.chipAccess')}
        </Button>
      </div>
      {accessNote ? <div className="sf-phone-note" style={{ fontSize: 13 }}>{t('helpPanel.accessNote')}</div> : null}

      {/* The error the user asked about */}
      {errorRef ? (
        <section aria-labelledby="sf-help-err" className="sf-phone-note" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h3 id="sf-help-err" style={{ margin: 0, fontSize: 14 }}>
            {t('helpPanel.errorTitle', { ref: errorRef })}
          </h3>
          {explained.isLoading ? (
            <Skeleton height={40} />
          ) : explained.error ? (
            <ErrorRef message={t('errors.loadFailed')} refId={errorRef} />
          ) : ex?.found ? (
            <>
              <Checked>
                {t('helpPanel.checkedError', { ref: ex.ref, when: ex.at ? `${formatDate(ex.at)} ${formatTime(ex.at)}` : '' })}
                {ex.rule_code ? <> · <span className="mono">{ex.rule_code}</span></> : null}
              </Checked>
              {ex.message ? <span style={{ fontSize: 14 }}>{t('helpPanel.serverSaid', { message: ex.message })}</span> : null}
              {ex.page ? (
                <>
                  <strong style={{ fontSize: 14 }}>{ex.page.title}</strong>
                  <HelpBody body={ex.page.body} />
                </>
              ) : (
                <span className="muted" style={{ fontSize: 13 }}>{t('helpPanel.noRulePage')}</span>
              )}
            </>
          ) : (
            <span style={{ fontSize: 14 }}>{t('helpPanel.errorNotFound')}</span>
          )}
          <Button size="sm" onClick={() => { setFiled(null); setMode('report') }} style={{ alignSelf: 'flex-start' }}>
            {t('helpPanel.reportThis')}
          </Button>
        </section>
      ) : null}

      {showRefInput && !errorRef ? (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            setErrorRef(refInput.trim().toUpperCase())
          }}
          style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}
        >
          <div style={{ flex: 1 }}>
            <Field label={t('helpPanel.refLabel')} value={refInput} onChange={(e) => setRefInput(e.target.value)} placeholder="ERR-" className="mono" autoComplete="off" />
          </div>
          <Button type="submit" disabled={refInput.trim().length < 4}>
            {t('helpPanel.explain')}
          </Button>
        </form>
      ) : null}

      {mode === 'report' ? (
        <section aria-labelledby="sf-help-report" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <h3 id="sf-help-report" style={{ margin: 0, fontSize: 15 }}>
            {t('helpPanel.reportTitle')}
          </h3>
          {filed ? (
            <div className="sf-phone-note" role="status" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span>{t('helpPanel.filed')}</span>
              <span className="mono">{filed.code}</span>
              {reportStatus('open', t)}
            </div>
          ) : (
            <form onSubmit={fileReport} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <TextAreaField label={t('helpPanel.whatHappened')} value={what} onChange={(e) => setWhat(e.target.value)} rows={4} maxLength={2000} />
              <span className="muted" style={{ fontSize: 12.5 }}>
                {t('helpPanel.sentWith', { screen: screen ?? window.location.pathname })}
                {errorRef ? ` · ${errorRef}` : ''}
              </span>
              {createMsg}
              <Button type="submit" variant="primary" busy={create.isPending} disabled={what.trim().length < 5} style={{ alignSelf: 'flex-start' }}>
                {t('helpPanel.send')}
              </Button>
            </form>
          )}
        </section>
      ) : null}

      {mode === 'page' ? (
        <section aria-labelledby="sf-help-page" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Button size="sm" variant="link" onClick={() => setMode('home')} style={{ alignSelf: 'flex-start' }}>
            {t('helpPanel.back')}
          </Button>
          {page.isLoading ? (
            <Skeleton height={80} />
          ) : pageData ? (
            <>
              <h3 id="sf-help-page" style={{ margin: 0, fontSize: 16 }}>
                {pageData.title}
              </h3>
              <HelpBody body={pageData.body} />
            </>
          ) : (
            <span id="sf-help-page">{t('helpPanel.pageMissing')}</span>
          )}
        </section>
      ) : null}

      {mode === 'home' ? (
        <>
          <form onSubmit={onSearch} role="search" style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}>
              <Field label={t('helpPanel.searchLabel')} type="search" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" />
            </div>
            <Button type="submit">{t('helpPanel.search')}</Button>
          </form>
          <section aria-labelledby="sf-help-results" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <h3 id="sf-help-results" style={{ margin: 0, fontSize: 13, color: 'var(--sf-text-muted)' }}>
              {submitted ? t('helpPanel.resultsFor', { q: submitted }) : screen ? t('helpPanel.forScreen') : t('helpPanel.suggested')}
            </h3>
            {search.isLoading ? (
              <Skeleton height={48} />
            ) : search.error ? (
              <ErrorRef message={t('errors.loadFailed')} refId="HELP" />
            ) : shown.length === 0 ? (
              <span className="muted" style={{ fontSize: 13 }}>
                {submitted ? t('helpPanel.noResults') : t('helpPanel.noScreenPage')}
              </span>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {shown.map((r) => (
                  <li key={r.slug}>
                    <button
                      type="button"
                      onClick={() => openPage(r.slug)}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        padding: '10px 12px',
                        border: '1px solid var(--sf-line)',
                        borderRadius: 10,
                        background: 'var(--sf-surface)',
                        cursor: 'pointer',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 2,
                        color: 'var(--sf-text)',
                      }}
                    >
                      <strong style={{ fontSize: 14 }}>{r.title}</strong>
                      <span style={{ fontSize: 12.5, color: 'var(--sf-text-2)' }}>{r.snippet.length > 140 ? `${r.snippet.slice(0, 140)}…` : r.snippet}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}

      {/* The user's own problem reports, with Admin's answer */}
      {mine.length ? (
        <section aria-labelledby="sf-help-mine" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <h3 id="sf-help-mine" style={{ margin: 0, fontSize: 13, color: 'var(--sf-text-muted)' }}>
            {t('helpPanel.myReports')}
          </h3>
          {mine.map((r) => (
            <div key={r.id} className="sf-phone-note" style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
              <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="mono">{r.code}</span>
                {reportStatus(r.status ?? 'open', t)}
                <span className="muted">{r.created_at ? formatDate(r.created_at) : ''}</span>
              </span>
              <span>{r.what_happened}</span>
              {r.reply ? <span>{t('helpPanel.reply', { reply: r.reply })}</span> : null}
            </div>
          ))}
        </section>
      ) : null}

      {isAdmin ? <AdminReports rows={toAnswer} loading={reports.isLoading} /> : null}
    </>
  )
}

/** Admin answers problem reports here (no reference screen exists for a separate queue). */
function AdminReports({ rows, loading }: { rows: Report[]; loading: boolean }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState<string | null>(null)
  const [reply, setReply] = useState('')
  const [status, setStatus] = useState('closed')
  const answer = useApiMutation<{ p_id: string; p_reply: string; p_status: string }>('answer_problem_report', [['api', 'problem_reports']])
  return (
    <section aria-labelledby="sf-help-admin" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <h3 id="sf-help-admin" style={{ margin: 0, fontSize: 13, color: 'var(--sf-text-muted)' }}>
        {t('helpPanel.toAnswer', { n: rows.length })}
      </h3>
      {loading ? <Skeleton height={40} /> : null}
      {!loading && rows.length === 0 ? <span className="muted" style={{ fontSize: 13 }}>{t('helpPanel.noneToAnswer')}</span> : null}
      {rows.slice(0, 10).map((r) => (
        <div key={r.id} className="sf-phone-note" style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
          <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="mono">{r.code}</span>
            {reportStatus(r.status ?? 'open', t)}
            <span className="muted">
              {r.user_name ?? ''} · {r.screen ?? ''} {r.error_ref ? `· ${r.error_ref}` : ''}
            </span>
          </span>
          <span>{r.what_happened}</span>
          {open === r.id ? (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                answer.mutate({ p_id: r.id ?? '', p_reply: reply.trim(), p_status: status }, { onSuccess: () => { setOpen(null); setReply('') } })
              }}
              style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
            >
              <TextAreaField label={t('helpPanel.answerLabel', { code: r.code })} value={reply} onChange={(e) => setReply(e.target.value)} rows={3} />
              <SelectField
                label={t('common.status')}
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                options={[
                  { value: 'closed', label: t('helpPanel.status.closed') },
                  { value: 'in_progress', label: t('helpPanel.status.in_progress') },
                ]}
              />
              <RpcErrorBox error={answer.error as RpcError | null} />
              <span className="sf-row" style={{ gap: 6 }}>
                <Button type="submit" variant="primary" size="sm" busy={answer.isPending} disabled={reply.trim().length < 2}>
                  {t('helpPanel.sendAnswer')}
                </Button>
                <Button size="sm" onClick={() => setOpen(null)}>
                  {t('common.cancel')}
                </Button>
              </span>
            </form>
          ) : (
            <Button size="sm" onClick={() => { setOpen(r.id); setReply(''); setStatus('closed') }} style={{ alignSelf: 'flex-start' }} aria-label={t('helpPanel.answerLabel', { code: r.code })}>
              {t('helpPanel.answer')}
            </Button>
          )}
        </div>
      ))}
    </section>
  )
}
