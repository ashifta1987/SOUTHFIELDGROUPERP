import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth, useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { RpcError, callApi, useApiMutation } from '@/data/rpc'
import { useCompanyChoice } from '@/features/admin/branches/company'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { MSME_CATEGORIES, RE_MOBILE, RE_PAN, RE_PIN, RE_UDYAM, SUPPLIER_DOC_KINDS, mobileDigits, toWhatsapp, useGstinCheck, usePartyDuplicates } from '@/features/sales/customers/parties'
import { BankChangeRequests, DuplicateWarning, GstinHint, PartyBank, PartyDocuments, PartyErrorBox } from '@/features/sales/customers/shared'
import { Button, Card, Chip, ComingInPhase, EmptyState, Field, FieldGrid, FormDialog, PageHeader, SelectField, Skeleton } from '@/ui'

type Supplier = ViewRow<'suppliers'>

interface Draft {
  id?: string
  legal_name: string
  trade_name: string
  gstin: string
  pan: string
  msme_category: string
  udyam_no: string
  supplies: string
  credit_term_id: string
  address: string
  city: string
  pincode: string
  contact_name: string
  whatsapp: string
  billing_id?: string
  contact_id?: string
}
const EMPTY: Draft = { legal_name: '', trade_name: '', gstin: '', pan: '', msme_category: '', udyam_no: '', supplies: '', credit_term_id: '', address: '', city: '', pincode: '', contact_name: '', whatsapp: '' }

/**
 * Suppliers · KYC (`SupplierKYC`, §8A). List from api.suppliers for the chosen company; the form saves through
 * api.upsert_party (is_supplier). Bank: the first account is added once; any later change is a request that a second
 * person calls back on and approves. MSME micro and small suppliers carry the 45-day payment limit.
 */
export function SuppliersPage() {
  const { t } = useTranslation()
  const { profile } = useAuth()
  const can = useCan()
  const { list: companies, company, companyId, choose, isLoading: companiesLoading } = useCompanyChoice()
  const suppliers = useApiView('suppliers', { eq: { company_id: companyId }, order: 'name', enabled: Boolean(companyId) })
  const [params, setParams] = useSearchParams()
  const [draft, setDraft] = useState<Draft | null>(null)
  const readOnly = profile?.view === 'all-readonly'
  const canCreate = !readOnly && can('purchase.create')
  const canEdit = !readOnly && can('purchase.edit')
  const list = rowsOf(suppliers)
  const selectedId = params.get('supplier')
  const selected = list.find((s) => s.id === selectedId) ?? list[0]

  function select(id: string) {
    const next = new URLSearchParams(params)
    next.set('supplier', id)
    setParams(next, { replace: true })
  }

  return (
    <>
      <PageHeader
        title={t('suppliers.title')}
        subtitle={suppliers.data?.status === 'ready' ? t('suppliers.subtitle', { count: list.length, company: company?.short_name || company?.name || '' }) : t('suppliers.subtitleNone')}
        actions={
          canCreate ? (
            <>
              <Button comingInPhase={4}>{t('suppliers.prefillFromBill')}</Button>
              <Button variant="primary" onClick={() => setDraft({ ...EMPTY })} disabled={!companyId}>
                {t('suppliers.add')}
              </Button>
            </>
          ) : null
        }
      />
      <div className="sf-row" style={{ justifyContent: 'space-between' }}>
        <CompanyPicker list={companies} value={companyId} onChange={choose} />
        <span className="k">{readOnly ? t('views.readOnly') : canEdit ? t('suppliers.rightsNote') : t('suppliers.viewOnly')}</span>
      </div>

      {companiesLoading || suppliers.isLoading ? (
        <Card>
          <Skeleton height={200} />
        </Card>
      ) : companies.length === 0 ? (
        <Card>
          <EmptyState title={t('suppliers.emptyTitle')} body={t('suppliers.noCompanies')} />
        </Card>
      ) : list.length === 0 ? (
        <Card>
          <EmptyState
            title={t('suppliers.emptyTitle')}
            body={t('suppliers.emptyBody')}
            action={
              canCreate ? (
                <Button variant="primary" onClick={() => setDraft({ ...EMPTY })}>
                  {t('suppliers.add')}
                </Button>
              ) : null
            }
          />
        </Card>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 300px) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
          <Card pad={false}>
            <ul aria-label={t('suppliers.listLabel')} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {list.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => select(s.id)}
                    aria-current={s.id === selected?.id ? 'true' : undefined}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                      width: '100%',
                      textAlign: 'left',
                      padding: '14px 18px',
                      border: 0,
                      borderBottom: '1px solid var(--sf-line-faint)',
                      borderLeft: s.id === selected?.id ? '4px solid var(--sf-primary)' : '4px solid transparent',
                      background: s.id === selected?.id ? 'var(--sf-paper)' : 'transparent',
                      cursor: 'pointer',
                      font: 'inherit',
                      color: 'inherit',
                    }}
                  >
                    <strong>{s.name}</strong>
                    <span className="k">
                      {[s.supplies, s.msme_category ? t('suppliers.udyamCat', { cat: t(`customersList.msme.${s.msme_category}`) }) : null, s.gstin].filter(Boolean).join(' · ') || t('suppliers.noDetails')}
                    </span>
                    <span>
                      <KycChip status={s.kyc_status} inactive={s.status === 'inactive'} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <p className="sf-card__foot">{t('suppliers.listFoot')}</p>
          </Card>
          {selected ? <SupplierDetail key={selected.id} s={selected} canEdit={canEdit} onEdit={(d) => setDraft(d)} /> : null}
        </div>
      )}

      {draft && companyId ? <SupplierDialog draft={draft} companyId={companyId} onClose={() => setDraft(null)} onSaved={(id) => select(id)} /> : null}
    </>
  )
}

function KycChip({ status, inactive }: { status: string; inactive?: boolean }) {
  const { t } = useTranslation()
  if (inactive)
    return (
      <Chip tone="neutral" icon="ban">
        {t('common.inactive')}
      </Chip>
    )
  if (status === 'verified')
    return (
      <Chip tone="success" icon="check">
        {t('suppliers.kyc.verified')}
      </Chip>
    )
  if (status === 'review')
    return (
      <Chip tone="info" icon="clock">
        {t('suppliers.kyc.review')}
      </Chip>
    )
  if (status === 'rejected')
    return (
      <Chip tone="danger" icon="cross">
        {t('suppliers.kyc.rejected')}
      </Chip>
    )
  return (
    <Chip tone="signal" icon="pencil">
      {t('suppliers.kyc.draft')}
    </Chip>
  )
}

function SupplierDetail({ s, canEdit, onEdit }: { s: Supplier; canEdit: boolean; onEdit: (d: Draft) => void }) {
  const { t } = useTranslation()
  const { profile } = useAuth()
  const can = useCan()
  const addresses = useApiView('party_addresses', { eq: { party_id: s.id } })
  const contacts = useApiView('party_contacts', { eq: { party_id: s.id } })
  const party = useApiView('parties', { eq: { id: s.id } })
  const pc = (rowsOf(party)[0]?.companies as unknown as { company_id: string; credit_term_id: string | null }[] | undefined)?.find((c) => c.company_id === s.company_id)
  const billing = rowsOf(addresses).find((a) => a.kind === 'billing')
  const contact = rowsOf(contacts).find((c) => c.is_primary) ?? rowsOf(contacts)[0]
  const kyc = useApiMutation<Record<string, unknown>>('set_party_kyc', [['api', 'suppliers'], ['api', 'parties']])
  const readOnly = profile?.view === 'all-readonly'
  const canVerify = !readOnly && (profile?.view === 'all' || can('kyc.view'))
  const panInside = Boolean(s.gstin && s.pan && s.gstin.slice(2, 12) === s.pan)
  const msmeLimited = s.msme_category === 'micro' || s.msme_category === 'small'

  function edit() {
    onEdit({
      id: s.id,
      legal_name: s.name,
      trade_name: s.trade_name ?? '',
      gstin: s.gstin ?? '',
      pan: s.pan ?? '',
      msme_category: s.msme_category ?? '',
      udyam_no: s.udyam_no ?? '',
      supplies: s.supplies ?? '',
      credit_term_id: pc?.credit_term_id ?? '',
      address: billing?.line1 ?? '',
      city: billing?.city ?? '',
      pincode: billing?.pincode ?? '',
      contact_name: contact?.name ?? '',
      whatsapp: contact?.whatsapp ? mobileDigits(contact.whatsapp) : '',
      billing_id: billing?.id,
      contact_id: contact?.id,
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section className="sf-card sf-card__pad" aria-labelledby={`sup-${s.id}`}>
        <div className="sf-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h2 id={`sup-${s.id}`} className="sf-card__title" style={{ fontSize: 20, margin: 0 }}>
              {s.name}
            </h2>
            <p className="muted" style={{ margin: '6px 0 0' }}>
              {billing ? [billing.line1, billing.city, billing.pincode].filter(Boolean).join(', ') : t('suppliers.noAddress')}
              {s.gstin ? ` · ${t(`customersList.states.${s.gstin.slice(0, 2)}`)}` : ''}
            </p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 10 }}>
            <KycChip status={s.kyc_status} inactive={s.status === 'inactive'} />
            <div className="sf-row" style={{ gap: 8 }}>
              {canEdit ? <Button onClick={edit}>{t('common.edit')}</Button> : null}
              {canEdit && (s.kyc_status === 'draft' || s.kyc_status === 'rejected') ? (
                <Button variant="primary" busy={kyc.isPending} onClick={() => kyc.mutate({ p_party_id: s.id, p_status: 'review', p_note: null })}>
                  {t('suppliers.sendForVerification')}
                </Button>
              ) : null}
              {canVerify && s.kyc_status === 'review' ? (
                <>
                  <Button busy={kyc.isPending && kyc.variables?.p_status === 'rejected'} onClick={() => kyc.mutate({ p_party_id: s.id, p_status: 'rejected', p_note: null })}>
                    {t('suppliers.reject')}
                  </Button>
                  <Button variant="primary" busy={kyc.isPending && kyc.variables?.p_status === 'verified'} onClick={() => kyc.mutate({ p_party_id: s.id, p_status: 'verified', p_note: null })}>
                    {t('suppliers.markVerified')}
                  </Button>
                </>
              ) : null}
            </div>
          </div>
        </div>
        <div style={{ marginTop: kyc.error ? 12 : 0 }}>
          <PartyErrorBox error={kyc.error} />
        </div>
      </section>

      <div className="sf-grid-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}>
        <Card title={t('suppliers.identity')}>
          <dl style={{ display: 'grid', gridTemplateColumns: '130px 1fr', gap: '8px 12px', margin: 0, fontSize: 13 }}>
            <dt className="muted">{t('suppliers.f.gstin')}</dt>
            <dd style={{ margin: 0 }}>
              {s.gstin ? <span className="mono">{s.gstin}</span> : <span className="muted">{t('suppliers.unregistered')}</span>}
              {panInside ? (
                <div>
                  <Chip tone="success" icon="check">
                    {t('customersList.party.panInside')}
                  </Chip>
                </div>
              ) : null}
            </dd>
            <dt className="muted">{t('suppliers.f.pan')}</dt>
            <dd className="mono" style={{ margin: 0 }}>
              {s.pan ?? '—'}
            </dd>
            <dt className="muted">{t('suppliers.f.udyam')}</dt>
            <dd style={{ margin: 0 }}>
              {s.udyam_no ? <span className="mono">{s.udyam_no}</span> : '—'}
              {s.msme_category ? <strong> · {t(`customersList.msme.${s.msme_category}`)}</strong> : null}
            </dd>
            <dt className="muted">{t('suppliers.f.supplies')}</dt>
            <dd style={{ margin: 0 }}>{s.supplies ?? '—'}</dd>
            <dt className="muted">{t('suppliers.f.terms')}</dt>
            <dd style={{ margin: 0 }}>{s.terms ? `${s.terms} · ${t('suppliers.days', { count: s.term_days ?? 0 })}` : '—'}</dd>
            <dt className="muted">{t('suppliers.f.contact')}</dt>
            <dd style={{ margin: 0 }}>
              {contact ? (
                <>
                  {contact.name}
                  {contact.whatsapp ? <span className="mono"> · ••{contact.whatsapp.slice(-4)}</span> : null}
                </>
              ) : (
                '—'
              )}
            </dd>
            <dt className="muted">{t('suppliers.f.tds')}</dt>
            <dd className="muted" style={{ margin: 0 }}>
              {t('suppliers.tdsByCa')}
            </dd>
          </dl>
        </Card>

        <Card title={t('suppliers.bankTitle')}>
          <PartyBank partyId={s.id} canEdit={canEdit} showRequests={false} note={s.bank_change_pending ? t('suppliers.bankPendingNote') : t('suppliers.bankNote')} />
        </Card>

        <PartyDocuments partyId={s.id} kinds={SUPPLIER_DOC_KINDS} canUpload={canEdit} title={t('suppliers.documents')} />

        <Card title={msmeLimited ? t('suppliers.msme.titleLimited', { cat: t(`customersList.msme.${s.msme_category}`) }) : t('suppliers.msme.title')}>
          {msmeLimited ? (
            <>
              <p style={{ marginTop: 0 }}>
                <Chip tone="signal" icon="clock">
                  {t('suppliers.msme.payWithin')}
                </Chip>
              </p>
              <p>{t('suppliers.msme.limitedBody')}</p>
              <p className="k" style={{ marginBottom: 0 }}>
                {t('suppliers.msme.caNote')}
              </p>
            </>
          ) : s.msme_category === 'medium' ? (
            <p style={{ margin: 0 }}>{t('suppliers.msme.mediumBody')}</p>
          ) : (
            <p style={{ margin: 0 }}>{t('suppliers.msme.unknownBody')}</p>
          )}
        </Card>
      </div>

      <BankChangeRequests partyId={s.id} card />

      <Card title={t('suppliers.bills')}>
        <ComingInPhase phase={4}>{t('suppliers.billsLater')}</ComingInPhase>
      </Card>
    </div>
  )
}

function SupplierDialog({ draft, companyId, onClose, onSaved }: { draft: Draft; companyId: string; onClose: () => void; onSaved: (id: string) => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const terms = useApiView('credit_terms', { order: 'days' })
  const [d, setD] = useState<Draft>(draft)
  const [errors, setErrors] = useState<Partial<Record<keyof Draft, string>>>({})
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<RpcError | null>(null)
  const [forceOffered, setForceOffered] = useState(false)
  const gstin = d.gstin.trim().toUpperCase()
  const { result: check, checking } = useGstinCheck(gstin)
  const dupes = usePartyDuplicates({ name: d.legal_name, gstin: gstin.length === 15 ? gstin : '', pan: RE_PAN.test(d.pan) ? d.pan : '', phone: RE_MOBILE.test(d.whatsapp) ? d.whatsapp : '', exclude: d.id })
  const termOptions = rowsOf(terms).filter((x) => x.active && (x.company_id === null || x.company_id === companyId))

  function onGstin(v: string) {
    const g = v.toUpperCase().replace(/\s/g, '').slice(0, 15)
    setD((prev) => ({ ...prev, gstin: g, pan: g.length >= 12 ? g.slice(2, 12) : prev.pan }))
  }

  async function save(force = false) {
    const e: Partial<Record<keyof Draft, string>> = {}
    if (d.legal_name.trim().length < 2) e.legal_name = t('suppliers.err.legalName')
    if (gstin && (gstin.length !== 15 || (check && !check.valid))) e.gstin = t('customersList.party.gstinInvalid')
    if (d.pan && !RE_PAN.test(d.pan)) e.pan = t('customersList.rules.party.pan_invalid')
    if (d.udyam_no && !RE_UDYAM.test(d.udyam_no)) e.udyam_no = t('suppliers.err.udyam')
    if (d.pincode && !RE_PIN.test(d.pincode)) e.pincode = t('suppliers.err.pincode')
    if (d.whatsapp && !RE_MOBILE.test(d.whatsapp)) e.whatsapp = t('suppliers.err.whatsapp')
    setErrors(e)
    if (Object.keys(e).length) return
    setBusy(true)
    setErr(null)
    try {
      const p: Record<string, unknown> = {
        company_id: companyId,
        is_supplier: true,
        trade_name: d.trade_name.trim(),
        gst_status: gstin ? 'registered' : 'unregistered',
        msme_category: d.msme_category,
        udyam_no: d.udyam_no,
        supplies: d.supplies.trim(),
        credit_term_id: d.credit_term_id || null,
      }
      if (d.id) {
        p.id = d.id
        if (d.legal_name.trim() !== draft.legal_name) p.legal_name = d.legal_name.trim()
        if (gstin !== draft.gstin) p.gstin = gstin || null
        if (d.pan !== draft.pan) p.pan = d.pan || null
      } else {
        Object.assign(p, {
          legal_name: d.legal_name.trim(),
          gstin: gstin || null,
          pan: d.pan || null,
          state_code: gstin ? gstin.slice(0, 2) : null,
          address: d.address.trim(),
          city: d.city.trim(),
          pincode: d.pincode,
          whatsapp: toWhatsapp(d.whatsapp),
          contact_name: d.contact_name.trim(),
          force,
        })
      }
      const res = await callApi<{ id: string }>('upsert_party', { p })
      if (d.id && (d.address !== draft.address || d.city !== draft.city || d.pincode !== draft.pincode) && d.address.trim()) {
        await callApi('upsert_party_address', { p: { id: d.billing_id ?? null, party_id: d.id, kind: 'billing', line1: d.address.trim(), city: d.city.trim(), pincode: d.pincode, state_code: gstin ? gstin.slice(0, 2) : null } })
      }
      if (d.id && (d.whatsapp !== draft.whatsapp || d.contact_name !== draft.contact_name) && d.whatsapp) {
        await callApi('upsert_party_contact', { p: { id: d.contact_id ?? null, party_id: d.id, name: d.contact_name.trim() || d.legal_name.trim(), whatsapp: toWhatsapp(d.whatsapp), is_primary: true } })
      }
      for (const k of ['suppliers', 'parties', 'party_addresses', 'party_contacts']) await qc.invalidateQueries({ queryKey: ['api', k] })
      onSaved(res.id)
      onClose()
    } catch (x) {
      const re = x as RpcError
      setErr(re)
      if (re.rule === 'masters.possible_duplicate') setForceOffered(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={d.id ? t('suppliers.editTitle') : t('suppliers.addTitle')}
      description={t('suppliers.formHelp')}
      submitLabel={t('common.save')}
      busy={busy}
      onSubmit={() => void save(false)}
      error={
        <>
          <PartyErrorBox error={err} />
          <DuplicateWarning list={dupes.list} forceOffered={!d.id && forceOffered} onForce={() => void save(true)} />
        </>
      }
      wide
    >
      <FieldGrid>
        <Field label={t('suppliers.f.legalName')} value={d.legal_name} onChange={(e) => setD({ ...d, legal_name: e.target.value })} error={errors.legal_name} />
        <Field label={t('suppliers.f.tradeName')} value={d.trade_name} onChange={(e) => setD({ ...d, trade_name: e.target.value })} />
        <Field
          label={t('suppliers.f.gstin')}
          className="mono"
          maxLength={15}
          value={d.gstin}
          onChange={(e) => onGstin(e.target.value)}
          error={errors.gstin ?? (gstin.length === 15 && check && !check.valid ? t('customersList.party.gstinInvalid') : undefined)}
          help={<GstinHint gstin={gstin} check={check} checking={checking} />}
        />
        <Field label={t('suppliers.f.pan')} className="mono" maxLength={10} value={d.pan} onChange={(e) => setD({ ...d, pan: e.target.value.toUpperCase() })} error={errors.pan} />
        <SelectField
          label={t('suppliers.f.msme')}
          value={d.msme_category}
          onChange={(e) => setD({ ...d, msme_category: e.target.value })}
          options={[{ value: '', label: t('suppliers.msmeNone') }, ...MSME_CATEGORIES.map((m) => ({ value: m, label: t(`customersList.msme.${m}`) }))]}
          help={d.msme_category === 'micro' || d.msme_category === 'small' ? t('suppliers.msme.payWithin') : undefined}
        />
        <Field label={t('suppliers.f.udyam')} className="mono" placeholder="UDYAM-XX-00-0000000" value={d.udyam_no} onChange={(e) => setD({ ...d, udyam_no: e.target.value.toUpperCase() })} error={errors.udyam_no} />
        <Field label={t('suppliers.f.supplies')} value={d.supplies} onChange={(e) => setD({ ...d, supplies: e.target.value })} />
        <SelectField
          label={t('suppliers.f.terms')}
          value={d.credit_term_id}
          onChange={(e) => setD({ ...d, credit_term_id: e.target.value })}
          placeholder={termOptions.length ? t('suppliers.termsNone') : t('suppliers.termsNotSetUp')}
          options={termOptions.map((x) => ({ value: x.id, label: `${x.label} · ${t('suppliers.days', { count: x.days })}` }))}
        />
        <Field label={t('suppliers.f.tds')} value={t('suppliers.tdsByCa')} disabled readOnly />
        <Field label={t('suppliers.f.contactName')} value={d.contact_name} onChange={(e) => setD({ ...d, contact_name: e.target.value })} />
        <Field label={t('suppliers.f.whatsapp')} className="mono" prefix="+91" inputMode="tel" value={d.whatsapp} onChange={(e) => setD({ ...d, whatsapp: mobileDigits(e.target.value) })} error={errors.whatsapp} />
        <Field label={t('suppliers.f.address')} value={d.address} onChange={(e) => setD({ ...d, address: e.target.value })} />
        <Field label={t('suppliers.f.city')} value={d.city} onChange={(e) => setD({ ...d, city: e.target.value })} />
        <Field label={t('suppliers.f.pincode')} className="mono" inputMode="numeric" maxLength={6} value={d.pincode} onChange={(e) => setD({ ...d, pincode: e.target.value.replace(/\D/g, '') })} error={errors.pincode} />
      </FieldGrid>
      <p className="k" style={{ marginBottom: 0 }}>
        {t('suppliers.bankInDetail')}
      </p>
    </FormDialog>
  )
}
