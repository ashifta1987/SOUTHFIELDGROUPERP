import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth, useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiView } from '@/data/queries'
import { RpcError, callApi, useApiMutation } from '@/data/rpc'
import { RpcErrorBox } from '@/features/common/RpcErrorBox'
import { todayIst } from '@/features/admin/branches/company'
import { supabase } from '@/shared/supabase'
import { formatDate } from '@/shared/format'
import { Button, Card, Chip, ErrorRef, Field, FieldGrid, FormDialog, SelectField, Skeleton, TextAreaField } from '@/ui'
import { BANK_PROOFS, RE_ACCOUNT, RE_IFSC, daysUntil, uploadPartyDocument, type DuplicateCandidate, type GstinCheck } from './parties'

/** Refusals from the party RPCs: our own rule texts first (customersList.rules.*), then the shared ones. */
export function PartyErrorBox({ error }: { error: Error | RpcError | null | undefined }) {
  const { t } = useTranslation()
  if (!error) return null
  if (error instanceof RpcError) {
    if (error.rule) {
      const key = `customersList.rules.${error.rule}`
      const msg = t(key)
      if (msg !== key) return <ErrorRef message={msg} next={t('errors.nextStep')} refId={error.ref} />
    }
    return <RpcErrorBox error={error} />
  }
  return <ErrorRef message={t('customersList.party.uploadFailed')} next={t('errors.nextStep')} refId={error.message.slice(0, 40)} />
}

/** "Valid · Kerala (32) · PAN inside matches" under the GSTIN field. */
export function GstinHint({ gstin, check, checking }: { gstin: string; check: GstinCheck | null; checking: boolean }) {
  const { t } = useTranslation()
  if (gstin.length === 0) return <span>{t('customersList.party.gstinHelp')}</span>
  if (gstin.length < 15) return <span>{t('customersList.party.gstinShort', { n: gstin.length })}</span>
  if (!check || checking) return <span>{t('customersList.party.gstinChecking')}</span>
  if (!check.valid) return null
  const stateKey = `customersList.states.${check.state_code}`
  const state = t(stateKey) === stateKey ? check.state_code : `${t(stateKey)} (${check.state_code})`
  return (
    <span className="sf-row" style={{ gap: 6 }}>
      <Chip tone="success" icon="check">
        {t('customersList.party.gstinValid')}
      </Chip>
      <span>{t('customersList.party.gstinState', { state, pan: check.pan })}</span>
    </span>
  )
}

/** Live duplicate warning with links to the parties that look the same. */
export function DuplicateWarning({ list, onForce, forceOffered, hrefFor }: { list: DuplicateCandidate[]; onForce?: () => void; forceOffered?: boolean; hrefFor?: (id: string) => string }) {
  const { t } = useTranslation()
  if (list.length === 0 && !forceOffered) return null
  return (
    <div className="sf-alert" data-tone="info" role="status" style={{ flexDirection: 'column', background: 'var(--sf-signal-tint)', color: 'var(--sf-signal-ink)' }}>
      <strong>{list.length ? t('customersList.party.dupTitle', { count: list.length }) : t('customersList.party.dupTitle', { count: 1 })}</strong>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {list.map((c) => (
          <li key={c.id}>
            {hrefFor ? (
              <Link to={hrefFor(c.id)} style={{ color: 'inherit', fontWeight: 600 }}>
                {c.name}
              </Link>
            ) : (
              <strong>{c.name}</strong>
            )}
            {c.gstin ? <span className="mono"> · {c.gstin}</span> : null} · {t(`customersList.party.dupReason.${c.reason}`)}
          </li>
        ))}
      </ul>
      <span>{t('customersList.party.dupNext')}</span>
      {forceOffered && onForce ? (
        <div>
          <Button size="sm" onClick={onForce}>
            {t('customersList.party.createAnyway')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

/** Documents of a party with expiry, plus an upload to the private `kyc` bucket (api.add_party_document). */
export function PartyDocuments({ partyId, kinds, canUpload, title }: { partyId: string | undefined; kinds: readonly string[]; canUpload: boolean; title: string }) {
  const { t } = useTranslation()
  const can = useCan()
  const qc = useQueryClient()
  const docs = useApiView('party_documents', { eq: { party_id: partyId }, order: 'uploaded_at', ascending: false, enabled: Boolean(partyId) })
  const list = rowsOf(docs)
  const [kind, setKind] = useState<string>(kinds[0] ?? 'other')
  const [expires, setExpires] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<Error | null>(null)
  const [done, setDone] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const today = todayIst()

  async function upload() {
    if (!partyId || !file) return
    setBusy(true)
    setErr(null)
    setDone(false)
    try {
      await uploadPartyDocument(partyId, kind, file, expires || null)
      await qc.invalidateQueries({ queryKey: ['api', 'party_documents'] })
      await qc.invalidateQueries({ queryKey: ['api', 'parties'] })
      setFile(null)
      setExpires('')
      if (fileRef.current) fileRef.current.value = ''
      setDone(true)
    } catch (e) {
      setErr(e as Error)
    } finally {
      setBusy(false)
    }
  }

  async function open(path: string) {
    const { data } = await supabase.storage.from('kyc').createSignedUrl(path, 60)
    if (data?.signedUrl) window.open(data.signedUrl, '_blank', 'noopener')
  }

  return (
    <Card title={title}>
      {!partyId ? (
        <p className="k" style={{ margin: 0 }}>
          {t('customersList.party.docsAfterSave')}
        </p>
      ) : docs.isLoading ? (
        <Skeleton height={60} />
      ) : (
        <>
          {list.length === 0 ? (
            <p className="k" style={{ marginTop: 0 }}>
              {t('customersList.party.docsNone')}
            </p>
          ) : (
            <ul style={{ listStyle: 'none', margin: '0 0 12px', padding: 0 }}>
              {list.map((d) => {
                const left = d.expires_on ? daysUntil(d.expires_on, today) : null
                return (
                  <li key={d.id} className="sf-row" style={{ justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--sf-line-faint)' }}>
                    <span style={{ display: 'flex', flexDirection: 'column' }}>
                      <strong style={{ fontSize: 13 }}>{t(`customersList.docKind.${d.kind}`)}</strong>
                      <span className="k">
                        {t('customersList.party.uploadedOn', { date: formatDate(d.uploaded_at) })}
                        {d.expires_on ? ` · ${t('customersList.party.expiresOn', { date: formatDate(d.expires_on) })}` : ''}
                      </span>
                    </span>
                    <span className="sf-row" style={{ gap: 6 }}>
                      {left === null ? (
                        <Chip tone="success" icon="check">
                          {t('customersList.party.attached')}
                        </Chip>
                      ) : left < 0 ? (
                        <Chip tone="danger" icon="alert">
                          {t('customersList.party.expired')}
                        </Chip>
                      ) : left <= 30 ? (
                        <Chip tone="signal" icon="clock">
                          {t('customersList.party.expiresSoon', { count: left })}
                        </Chip>
                      ) : (
                        <Chip tone="success" icon="check">
                          {t('customersList.party.attached')}
                        </Chip>
                      )}
                      {can('kyc.view') ? (
                        <Button size="sm" variant="link" onClick={() => void open(d.storage_path)} aria-label={t('customersList.party.openDoc', { kind: t(`customersList.docKind.${d.kind}`) })}>
                          {t('customersList.party.open')}
                        </Button>
                      ) : null}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
          {canUpload ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <SelectField label={t('customersList.party.docKindLabel')} value={kind} onChange={(e) => setKind(e.target.value)} options={kinds.map((k) => ({ value: k, label: t(`customersList.docKind.${k}`) }))} />
              <Field label={t('customersList.party.docExpiry')} type="date" value={expires} onChange={(e) => setExpires(e.target.value)} help={t('customersList.party.docExpiryHelp')} />
              <div className="sf-field">
                <label className="sf-field__label" htmlFor={`doc-file-${partyId}`}>
                  {t('customersList.party.docFile')}
                </label>
                <input ref={fileRef} id={`doc-file-${partyId}`} type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              </div>
              <PartyErrorBox error={err} />
              {done ? (
                <span className="k" role="status">
                  {t('customersList.party.uploaded')}
                </span>
              ) : null}
              <Button onClick={() => void upload()} disabled={!file} busy={busy}>
                {t('customersList.party.upload')}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </Card>
  )
}

/**
 * The party's active bank account, masked (••1234). "Show full number" calls api.view_bank_account (logged) and is
 * offered only with the bank.view_full right. First account → add; afterwards only a change request.
 */
export function PartyBank({ partyId, canEdit, note, showRequests = true }: { partyId: string; canEdit: boolean; note?: string; showRequests?: boolean }) {
  const { t } = useTranslation()
  const can = useCan()
  const accounts = useApiView('party_bank_accounts', { eq: { party_id: partyId }, order: 'created_at', ascending: false })
  const active = rowsOf(accounts).filter((a) => a.active)
  const [dialog, setDialog] = useState<'first' | 'change' | null>(null)
  const [full, setFull] = useState<Record<string, string>>({})
  const [showErr, setShowErr] = useState<RpcError | null>(null)

  async function show(id: string) {
    setShowErr(null)
    try {
      const v = await callApi<string>('view_bank_account', { p_account_id: id }, { idempotent: false })
      setFull((f) => ({ ...f, [id]: v }))
    } catch (e) {
      setShowErr(e as RpcError)
    }
  }

  if (accounts.isLoading) return <Skeleton height={60} />
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {active.length === 0 ? (
        <p className="k" style={{ margin: 0 }}>
          {t('customersList.bank.none')}
        </p>
      ) : (
        active.map((a) => (
          <dl key={a.id} style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '6px 12px', margin: 0, fontSize: 13 }}>
            <dt className="muted">{t('customersList.bank.bankName')}</dt>
            <dd style={{ margin: 0 }}>{a.bank_name ?? '—'}</dd>
            <dt className="muted">{t('customersList.bank.ifsc')}</dt>
            <dd className="mono" style={{ margin: 0 }}>
              {a.ifsc}
            </dd>
            <dt className="muted">{t('customersList.bank.account')}</dt>
            <dd style={{ margin: 0 }}>
              <span className="mono">{full[a.id] ?? a.account_masked}</span>{' '}
              {can('bank.view_full') && !full[a.id] ? (
                <Button size="sm" variant="link" onClick={() => void show(a.id)}>
                  {t('customersList.bank.showFull')}
                </Button>
              ) : null}
            </dd>
            <dt className="muted">{t('customersList.bank.proof')}</dt>
            <dd style={{ margin: 0 }}>{a.verified_by ? t(`customersList.bank.proofs.${a.verified_by}`) : '—'}</dd>
          </dl>
        ))
      )}
      <PartyErrorBox error={showErr} />
      {note ? (
        <div className="sf-alert" data-tone="info" style={{ background: 'var(--sf-signal-tint)', color: 'var(--sf-signal-ink)' }}>
          <span>{note}</span>
        </div>
      ) : null}
      {canEdit ? (
        <div>
          {active.length === 0 ? (
            <Button onClick={() => setDialog('first')}>{t('customersList.bank.addFirst')}</Button>
          ) : (
            <Button onClick={() => setDialog('change')}>{t('customersList.bank.requestChange')}</Button>
          )}
        </div>
      ) : null}
      {showRequests ? <BankChangeRequests partyId={partyId} /> : null}
      <BankAccountDialog partyId={partyId} mode={dialog ?? 'first'} open={dialog !== null} onOpenChange={(o) => !o && setDialog(null)} />
    </div>
  )
}

interface BankDraft {
  account: string
  ifsc: string
  bank: string
  proof: string
  reason: string
}

/**
 * Pending and past bank change requests of a party: requested → call-back recorded by a second person → approved.
 * The server refuses the requester at every later step (sod.self_approval).
 */
export function BankChangeRequests({ partyId, card }: { partyId: string; card?: boolean }) {
  const { t } = useTranslation()
  const can = useCan()
  const { profile } = useAuth()
  const readOnly = profile?.view === 'all-readonly'
  const canApprove = !readOnly && can('bank_change.approve')
  const reqs = useApiView('bank_change_requests', { eq: { party_id: partyId }, order: 'requested_at', ascending: false })
  const list = rowsOf(reqs)
  const inv = [['api', 'bank_change_requests'], ['api', 'party_bank_accounts'], ['api', 'suppliers'], ['api', 'parties']]
  const callback = useApiMutation<Record<string, unknown>>('record_bank_callback', inv)
  const decide = useApiMutation<Record<string, unknown>>('decide_bank_change', inv)
  const [cb, setCb] = useState<{ id: string; number: string; note: string } | null>(null)
  const [cbErr, setCbErr] = useState<string | undefined>()
  const lastError = decide.error ?? (cb ? null : callback.error)

  if (reqs.isLoading) return <Skeleton height={40} />
  if (list.length === 0) return null

  function submitCallback() {
    if (!cb) return
    if (cb.note.trim().length < 5) {
      setCbErr(t('customersList.rules.bank.callback_note'))
      return
    }
    setCbErr(undefined)
    callback.mutate({ p_request_id: cb.id, p_number_called: cb.number.trim(), p_note: cb.note.trim() }, { onSuccess: () => setCb(null) })
  }

  return (
    <div className={card ? 'sf-card sf-card__pad' : undefined} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h3 className="sf-card__title" style={{ fontSize: card ? undefined : 14, margin: 0 }}>
        {t('customersList.bankReq.title')}
      </h3>
      <PartyErrorBox error={lastError} />
      <div className="sf-table-wrap">
        <table className="sf-table">
          <caption className="sr-only">{t('customersList.bankReq.title')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('customersList.bankReq.requested')}</th>
              <th scope="col">{t('customersList.bankReq.newAccount')}</th>
              <th scope="col">{t('customersList.bankReq.callback')}</th>
              <th scope="col">{t('common.status')}</th>
              {canApprove ? <th scope="col">{t('customersList.bankReq.actions')}</th> : null}
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id}>
                <td>
                  <span style={{ display: 'flex', flexDirection: 'column' }}>
                    <span>{r.requested_by_name ?? '—'}</span>
                    <span className="k mono">{formatDate(r.requested_at)}</span>
                    <span className="k">{r.reason}</span>
                  </span>
                </td>
                <td>
                  <span className="mono">{r.ifsc}</span>
                  {r.bank_name ? <span className="k"> · {r.bank_name}</span> : null}
                </td>
                <td>
                  {r.callback_at ? (
                    <span style={{ display: 'flex', flexDirection: 'column' }}>
                      <Chip tone="success" icon="check">
                        {t('customersList.bankReq.calledOn', { date: formatDate(r.callback_at) })}
                      </Chip>
                      {r.callback_note ? <span className="k">{r.callback_note}</span> : null}
                    </span>
                  ) : (
                    <Chip tone="signal" icon="clock">
                      {t('customersList.bankReq.callbackPending')}
                    </Chip>
                  )}
                </td>
                <td>
                  {r.status === 'approved' ? (
                    <Chip tone="success" icon="check">
                      {t('customersList.bankReq.approved')}
                    </Chip>
                  ) : r.status === 'refused' ? (
                    <Chip tone="neutral" icon="ban">
                      {t('customersList.bankReq.refused')}
                    </Chip>
                  ) : (
                    <Chip tone="signal" icon="clock">
                      {t('customersList.bankReq.pending')}
                    </Chip>
                  )}
                </td>
                {canApprove ? (
                  <td>
                    {r.status === 'pending' ? (
                      <span className="sf-row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                        {!r.callback_at ? (
                          <Button
                            size="sm"
                            onClick={() => {
                              callback.reset()
                              decide.reset()
                              setCbErr(undefined)
                              setCb({ id: r.id, number: '', note: '' })
                            }}
                          >
                            {t('customersList.bankReq.recordCallback')}
                          </Button>
                        ) : null}
                        <Button
                          size="sm"
                          variant="primary"
                          busy={decide.isPending && decide.variables?.p_request_id === r.id && decide.variables?.p_approve === true}
                          onClick={() => {
                            callback.reset()
                            decide.mutate({ p_request_id: r.id, p_approve: true })
                          }}
                        >
                          {t('customersList.bankReq.approve')}
                        </Button>
                        <Button
                          size="sm"
                          busy={decide.isPending && decide.variables?.p_request_id === r.id && decide.variables?.p_approve === false}
                          onClick={() => {
                            callback.reset()
                            decide.mutate({ p_request_id: r.id, p_approve: false })
                          }}
                        >
                          {t('customersList.bankReq.refuse')}
                        </Button>
                      </span>
                    ) : (
                      <span className="k">{r.decided_at ? formatDate(r.decided_at) : '—'}</span>
                    )}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <FormDialog
        open={cb !== null}
        onOpenChange={(o) => !o && setCb(null)}
        title={t('customersList.bankReq.callbackTitle')}
        description={t('customersList.bankReq.callbackHelp')}
        submitLabel={t('common.save')}
        busy={callback.isPending}
        onSubmit={submitCallback}
        error={<PartyErrorBox error={callback.error} />}
      >
        {cb ? (
          <FieldGrid cols={1}>
            <Field label={t('customersList.bankReq.numberCalled')} className="mono" inputMode="tel" value={cb.number} onChange={(e) => setCb({ ...cb, number: e.target.value })} help={t('customersList.bankReq.numberHelp')} />
            <TextAreaField label={t('customersList.bankReq.note')} value={cb.note} onChange={(e) => setCb({ ...cb, note: e.target.value })} error={cbErr} />
          </FieldGrid>
        ) : null}
      </FormDialog>
    </div>
  )
}

/**
 * First bank account (api.add_party_bank_account) or a change request (api.request_bank_change).
 * A change never edits the account: a second person records the call-back and approves it.
 */
export function BankAccountDialog({ partyId, mode, open, onOpenChange }: { partyId: string; mode: 'first' | 'change'; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation()
  const first = useApiMutation<Record<string, unknown>>('add_party_bank_account', [['api', 'party_bank_accounts'], ['api', 'suppliers'], ['api', 'parties']])
  const change = useApiMutation<Record<string, unknown>>('request_bank_change', [['api', 'bank_change_requests'], ['api', 'suppliers']])
  const m = mode === 'first' ? first : change
  const [d, setD] = useState<BankDraft>({ account: '', ifsc: '', bank: '', proof: 'cancelled_cheque', reason: '' })
  const [errors, setErrors] = useState<Partial<Record<keyof BankDraft, string>>>({})

  function submit() {
    const e: Partial<Record<keyof BankDraft, string>> = {}
    if (!RE_ACCOUNT.test(d.account.replace(/\D/g, ''))) e.account = t('customersList.bank.errAccount')
    if (!RE_IFSC.test(d.ifsc.trim().toUpperCase())) e.ifsc = t('customersList.bank.errIfsc')
    if (mode === 'change' && d.reason.trim().length < 5) e.reason = t('customersList.bank.errReason')
    setErrors(e)
    if (Object.keys(e).length) return
    const base = { p_party_id: partyId, p_account_no: d.account.replace(/\D/g, ''), p_ifsc: d.ifsc.trim().toUpperCase(), p_bank_name: d.bank.trim() || null }
    const args = mode === 'first' ? { ...base, p_verified_by: d.proof } : { ...base, p_reason: d.reason.trim() }
    m.mutate(args, {
      onSuccess: () => {
        setD({ account: '', ifsc: '', bank: '', proof: 'cancelled_cheque', reason: '' })
        onOpenChange(false)
      },
    })
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => {
        if (o) m.reset()
        onOpenChange(o)
      }}
      title={mode === 'first' ? t('customersList.bank.firstTitle') : t('customersList.bank.changeTitle')}
      description={mode === 'first' ? t('customersList.bank.firstHelp') : t('customersList.bank.changeHelp')}
      submitLabel={mode === 'first' ? t('common.save') : t('customersList.bank.sendRequest')}
      busy={m.isPending}
      onSubmit={submit}
      error={<PartyErrorBox error={m.error} />}
    >
      <FieldGrid>
        <Field label={t('customersList.bank.account')} className="mono" inputMode="numeric" autoComplete="off" value={d.account} onChange={(e) => setD({ ...d, account: e.target.value })} error={errors.account} />
        <Field label={t('customersList.bank.ifsc')} className="mono" maxLength={11} value={d.ifsc} onChange={(e) => setD({ ...d, ifsc: e.target.value.toUpperCase() })} error={errors.ifsc} />
        <Field label={t('customersList.bank.bankName')} value={d.bank} onChange={(e) => setD({ ...d, bank: e.target.value })} />
        {mode === 'first' ? (
          <SelectField label={t('customersList.bank.proof')} value={d.proof} onChange={(e) => setD({ ...d, proof: e.target.value })} options={BANK_PROOFS.map((p) => ({ value: p, label: t(`customersList.bank.proofs.${p}`) }))} />
        ) : null}
      </FieldGrid>
      {mode === 'change' ? (
        <div style={{ marginTop: 12 }}>
          <TextAreaField label={t('common.reason')} value={d.reason} onChange={(e) => setD({ ...d, reason: e.target.value })} error={errors.reason} />
        </div>
      ) : null}
    </FormDialog>
  )
}
