import { useState, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth, useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { RpcError, callApi, useApiMutation } from '@/data/rpc'
import { routeForFile } from '@/app/flows'
import { formatDate } from '@/shared/format'
import { useCompanyChoice } from '@/features/admin/branches/company'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import {
  CONTACT_LANGUAGES,
  CUSTOMER_DOC_KINDS,
  CUSTOMER_TYPES,
  GST_STATUSES,
  RE_MOBILE,
  RE_PAN,
  RE_PIN,
  RE_UDYAM,
  mobileDigits,
  toWhatsapp,
  useGstinCheck,
  usePartyDuplicates,
} from '@/features/sales/customers/parties'
import { BankChangeRequests, DuplicateWarning, GstinHint, PartyBank, PartyDocuments, PartyErrorBox } from '@/features/sales/customers/shared'
import { Button, Card, Checkbox, Chip, EmptyState, Field, FieldGrid, PageHeader, SelectField, Skeleton, TextAreaField } from '@/ui'

type Party = ViewRow<'parties'>
type Contact = ViewRow<'party_contacts'>
type Address = ViewRow<'party_addresses'>
type PartyCompany = { company_id: string; credit_term_id: string | null; beat: string | null; tier: string | null; is_customer: boolean }

interface Draft {
  customer_type: string
  gst_status: string
  gstin: string
  legal_name: string
  trade_name: string
  pan: string
  udyam_no: string
  address: string
  city: string
  pincode: string
  state_code: string
  lat: string
  lng: string
  contact_name: string
  whatsapp: string
  consent: boolean
  language: string
  beat: string
  tier: string
  credit_term_id: string
}
const EMPTY: Draft = {
  customer_type: 'retail_shop',
  gst_status: 'registered',
  gstin: '',
  legal_name: '',
  trade_name: '',
  pan: '',
  udyam_no: '',
  address: '',
  city: '',
  pincode: '',
  state_code: '',
  lat: '',
  lng: '',
  contact_name: '',
  whatsapp: '',
  consent: false,
  language: 'en',
  beat: '',
  tier: '',
  credit_term_id: '',
}

/**
 * Customer KYC (`CustomerKYC`, §8A). `?party=<id>` edits that party, otherwise a new customer is proposed.
 * Saves go through api.upsert_party (+ contact and address RPCs when editing); KYC steps through api.set_party_kyc,
 * where the server refuses the proposer as verifier. Credit limits come from the credit approval in Phase 6.
 */
export function CustomerKycPage() {
  const { t } = useTranslation()
  const [params] = useSearchParams()
  const partyId = params.get('party') ?? undefined
  const party = useApiView('parties', { eq: { id: partyId }, enabled: Boolean(partyId) })
  const contacts = useApiView('party_contacts', { eq: { party_id: partyId }, enabled: Boolean(partyId) })
  const addresses = useApiView('party_addresses', { eq: { party_id: partyId }, enabled: Boolean(partyId) })

  if (partyId && (party.isLoading || contacts.isLoading || addresses.isLoading)) {
    return (
      <>
        <PageHeader title={t('customerKyc.title')} subtitle={t('customerKyc.subtitle')} />
        <Card>
          <Skeleton height={240} />
        </Card>
      </>
    )
  }
  const row = rowsOf(party)[0]
  if (partyId && !row) {
    return (
      <>
        <PageHeader title={t('customerKyc.title')} subtitle={t('customerKyc.subtitle')} />
        <Card>
          <EmptyState
            title={t('customerKyc.notFound')}
            body={t('customerKyc.notFoundBody')}
            action={
              <Link to={routeForFile('Customers')} style={{ fontWeight: 600 }}>
                {t('customerKyc.backToList')}
              </Link>
            }
          />
        </Card>
      </>
    )
  }
  return <KycForm key={partyId ?? 'new'} party={row} contacts={rowsOf(contacts)} addresses={rowsOf(addresses)} />
}

function draftFrom(p: Party | undefined, contact: Contact | undefined, billing: Address | undefined, pc: PartyCompany | undefined): Draft {
  if (!p) return { ...EMPTY }
  return {
    customer_type: p.customer_type ?? 'retail_shop',
    gst_status: p.gst_status,
    gstin: p.gstin ?? '',
    legal_name: p.legal_name,
    trade_name: p.trade_name ?? '',
    pan: p.pan ?? '',
    udyam_no: p.udyam_no ?? '',
    address: billing?.line1 ?? '',
    city: billing?.city ?? '',
    pincode: billing?.pincode ?? '',
    state_code: billing?.state_code ?? p.state_code ?? '',
    lat: billing?.lat != null ? String(billing.lat) : '',
    lng: billing?.lng != null ? String(billing.lng) : '',
    contact_name: contact?.name ?? '',
    whatsapp: contact?.whatsapp ? mobileDigits(contact.whatsapp) : '',
    consent: contact?.whatsapp_consent ?? false,
    language: contact?.language ?? 'en',
    beat: pc?.beat ?? '',
    tier: pc?.tier ?? '',
    credit_term_id: pc?.credit_term_id ?? '',
  }
}

function KycForm({ party, contacts, addresses }: { party: Party | undefined; contacts: Contact[]; addresses: Address[] }) {
  const { t } = useTranslation()
  const { profile } = useAuth()
  const can = useCan()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { list: companies, company, companyId, choose, isLoading: companiesLoading } = useCompanyChoice()
  const terms = useApiView('credit_terms', { order: 'days' })
  const partyCompanies = (Array.isArray(party?.companies) ? party.companies : []) as unknown as PartyCompany[]
  const linked = partyCompanies.find((c) => c.company_id === companyId)
  const contact = contacts.find((c) => c.is_primary) ?? contacts[0]
  const billing = addresses.find((a) => a.kind === 'billing')
  const deliveries = addresses.filter((a) => a.kind === 'delivery')
  const [original, setOriginal] = useState<Draft>(() => draftFrom(party, contact, billing, linked))
  const [d, setD] = useState<Draft>(original)
  const [errors, setErrors] = useState<Partial<Record<keyof Draft, string>>>({})
  const [busy, setBusy] = useState(false)
  const [saveErr, setSaveErr] = useState<RpcError | null>(null)
  const [forceOffered, setForceOffered] = useState(false)
  const [saved, setSaved] = useState(false)
  const [kycNote, setKycNote] = useState('')
  const kyc = useApiMutation<Record<string, unknown>>('set_party_kyc', [['api', 'parties'], ['api', 'customers']])

  const readOnly = profile?.view === 'all-readonly'
  const isNew = !party
  const canSave = !readOnly && (isNew ? can('sales.create') : can('sales.edit'))
  const canVerify = !readOnly && (profile?.view === 'all' || can('kyc.view'))
  const status = party?.kyc_status ?? 'draft'
  const gstin = d.gstin.trim().toUpperCase()
  const { result: check, checking } = useGstinCheck(gstin)
  const dupes = usePartyDuplicates({ name: d.legal_name, gstin: gstin.length === 15 ? gstin : '', pan: RE_PAN.test(d.pan) ? d.pan : '', phone: RE_MOBILE.test(d.whatsapp) ? d.whatsapp : '', exclude: party?.id })
  const termOptions = rowsOf(terms).filter((x) => x.active && (x.company_id === null || x.company_id === companyId))

  function set<K extends keyof Draft>(k: K, v: Draft[K]) {
    setSaved(false)
    setD((prev) => ({ ...prev, [k]: v }))
  }
  function onGstin(v: string) {
    const g = v.toUpperCase().replace(/\s/g, '').slice(0, 15)
    setSaved(false)
    setD((prev) => {
      const next = { ...prev, gstin: g }
      // Characters 3–12 of a GSTIN are the PAN and 1–2 the state; the server checks both again.
      if (g.length >= 12) next.pan = g.slice(2, 12)
      if (g.length >= 2) next.state_code = g.slice(0, 2)
      if (g.length > 0) next.gst_status = 'registered'
      return next
    })
  }

  function validate(): Partial<Record<keyof Draft, string>> {
    const e: Partial<Record<keyof Draft, string>> = {}
    if (d.legal_name.trim().length < 2) e.legal_name = t('customerKyc.err.legalName')
    if (gstin && (gstin.length !== 15 || (check && !check.valid))) e.gstin = t('customersList.party.gstinInvalid')
    if (d.pan && !RE_PAN.test(d.pan)) e.pan = t('customersList.rules.party.pan_invalid')
    if (d.udyam_no && !RE_UDYAM.test(d.udyam_no)) e.udyam_no = t('customerKyc.err.udyam')
    if (d.pincode && !RE_PIN.test(d.pincode)) e.pincode = t('customerKyc.err.pincode')
    if (d.whatsapp && !RE_MOBILE.test(d.whatsapp)) e.whatsapp = t('customerKyc.err.whatsapp')
    if (d.lat && (Number.isNaN(Number(d.lat)) || Math.abs(Number(d.lat)) > 90)) e.lat = t('customerKyc.err.lat')
    if (d.lng && (Number.isNaN(Number(d.lng)) || Math.abs(Number(d.lng)) > 180)) e.lng = t('customerKyc.err.lng')
    if ((d.lat && !d.lng) || (!d.lat && d.lng)) e.lng = t('customerKyc.err.pinBoth')
    return e
  }

  async function save(force = false) {
    const e = validate()
    setErrors(e)
    if (Object.keys(e).length) return
    if (!companyId) return
    setBusy(true)
    setSaveErr(null)
    setSaved(false)
    const hasPin = Boolean(d.lat && d.lng)
    try {
      if (isNew) {
        const p: Record<string, unknown> = {
          company_id: companyId,
          is_customer: true,
          legal_name: d.legal_name.trim(),
          trade_name: d.trade_name.trim(),
          gstin: gstin || null,
          pan: d.pan || null,
          gst_status: gstin ? 'registered' : d.gst_status,
          customer_type: d.customer_type,
          udyam_no: d.udyam_no,
          credit_term_id: d.credit_term_id || null,
          beat: d.beat.trim(),
          tier: d.tier.trim(),
          whatsapp: toWhatsapp(d.whatsapp),
          contact_name: d.contact_name.trim(),
          whatsapp_consent: d.consent && Boolean(d.whatsapp),
          language: d.language,
          state_code: d.state_code || null,
          force,
        }
        if (d.address.trim() && !hasPin) Object.assign(p, { address: d.address.trim(), city: d.city.trim(), pincode: d.pincode })
        const res = await callApi<{ id: string }>('upsert_party', { p })
        if (d.address.trim() && hasPin) {
          await callApi('upsert_party_address', { p: { party_id: res.id, kind: 'billing', line1: d.address.trim(), city: d.city.trim(), pincode: d.pincode, state_code: d.state_code || null, lat: d.lat, lng: d.lng } })
        }
        await invalidate()
        navigate(`${routeForFile('CustomerKYC')}?party=${res.id}&company=${companyId}`, { replace: true })
        return
      }
      const p: Record<string, unknown> = {
        id: party.id,
        company_id: companyId,
        is_customer: true,
        trade_name: d.trade_name.trim(),
        gst_status: gstin ? 'registered' : d.gst_status,
        customer_type: d.customer_type,
        udyam_no: d.udyam_no,
        credit_term_id: d.credit_term_id || null,
        beat: d.beat.trim(),
        tier: d.tier.trim(),
      }
      // Name, GSTIN and PAN are sent only when changed (verified KYC locks them for everyone but Admin).
      if (d.legal_name.trim() !== original.legal_name) p.legal_name = d.legal_name.trim()
      if (gstin !== original.gstin) p.gstin = gstin || null
      if (d.pan !== original.pan) p.pan = d.pan || null
      await callApi('upsert_party', { p })
      if (d.contact_name !== original.contact_name || d.whatsapp !== original.whatsapp || d.consent !== original.consent || d.language !== original.language) {
        await callApi('upsert_party_contact', {
          p: { id: contact?.id ?? null, party_id: party.id, name: d.contact_name.trim() || d.legal_name.trim(), whatsapp: toWhatsapp(d.whatsapp) ?? '', whatsapp_consent: d.consent && Boolean(d.whatsapp), language: d.language, is_primary: true },
        })
      }
      if (d.address !== original.address || d.city !== original.city || d.pincode !== original.pincode || d.lat !== original.lat || d.lng !== original.lng) {
        await callApi('upsert_party_address', {
          p: { id: billing?.id ?? null, party_id: party.id, kind: 'billing', line1: d.address.trim(), city: d.city.trim(), pincode: d.pincode, state_code: d.state_code || null, lat: d.lat, lng: d.lng },
        })
      }
      await invalidate()
      setOriginal({ ...d, gstin })
      setSaved(true)
    } catch (err) {
      const re = err as RpcError
      setSaveErr(re)
      if (re.rule === 'masters.possible_duplicate') setForceOffered(true)
    } finally {
      setBusy(false)
    }
  }

  async function invalidate() {
    for (const k of ['parties', 'customers', 'party_contacts', 'party_addresses']) await qc.invalidateQueries({ queryKey: ['api', k] })
  }

  function step(to: 'review' | 'verified' | 'rejected') {
    if (!party) return
    kyc.mutate({ p_party_id: party.id, p_status: to, p_note: kycNote.trim() || null }, { onSuccess: () => setKycNote('') })
  }

  const disabled = !canSave || busy
  const steps = [
    { key: 'draft', label: t('customerKyc.track.proposed') },
    { key: 'review', label: t('customerKyc.track.office') },
    { key: 'credit', label: t('customerKyc.track.credit') },
    { key: 'verified', label: t('customerKyc.track.active') },
  ]
  const currentStep = status === 'rejected' ? 'draft' : status

  return (
    <>
      <nav aria-label={t('customerKyc.breadcrumb')} className="k" style={{ fontSize: 13 }}>
        <Link to={`${routeForFile('Customers')}${companyId ? `?company=${companyId}` : ''}`}>{t('customersList.title')}</Link> / {party ? party.legal_name : t('customerKyc.newBuyer')}
      </nav>
      <PageHeader
        title={t('customerKyc.title')}
        subtitle={t('customerKyc.subtitle')}
        actions={
          <ol aria-label={t('customerKyc.track.label')} className="sf-row" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 6 }}>
            {status === 'rejected' ? (
              <li>
                <Chip tone="danger" icon="cross">
                  {t('customersList.kyc.rejected')}
                </Chip>
              </li>
            ) : null}
            {steps.map((s) => (
              <li key={s.key} aria-current={s.key === currentStep ? 'step' : undefined}>
                <Chip tone={s.key === currentStep ? 'info' : 'neutral'} icon={s.key === currentStep ? 'check' : undefined}>
                  {s.label}
                </Chip>
              </li>
            ))}
          </ol>
        }
      />

      {readOnly ? <p className="k">{t('views.readOnly')}</p> : !canSave ? <p className="k">{t('customerKyc.noRight')}</p> : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2.6fr) minmax(280px, 1fr)', gap: 16, alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card title={t('customerKyc.identity')}>
            {companiesLoading ? <Skeleton height={36} /> : companies.length > 1 ? <div style={{ marginBottom: 12 }}><CompanyPicker list={companies} value={companyId} onChange={choose} /></div> : null}
            {company && party && !linked ? <p className="k">{t('customerKyc.linkCompany', { company: company.short_name || company.name })}</p> : null}
            <div className="sf-row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
              <div style={{ flex: 1 }}>
                <Field
                  label={t('customerKyc.f.gstin')}
                  className="mono"
                  value={d.gstin}
                  maxLength={15}
                  autoComplete="off"
                  onChange={(e) => onGstin(e.target.value)}
                  error={errors.gstin ?? (gstin.length === 15 && check && !check.valid ? t('customersList.party.gstinInvalid') : undefined)}
                  warning={!gstin && d.gst_status === 'registered' ? t('customerKyc.warnNoGstin') : undefined}
                  help={<GstinHint gstin={gstin} check={check} checking={checking} />}
                  disabled={disabled}
                />
              </div>
              <div style={{ paddingTop: 22 }}>
                <Button comingInPhase={8}>{t('customerKyc.fetchGstin')}</Button>
              </div>
            </div>
            <div style={{ marginTop: 12 }}>
              <Grid3>
                <Field label={t('customerKyc.f.legalName')} value={d.legal_name} onChange={(e) => set('legal_name', e.target.value)} error={errors.legal_name} disabled={disabled} />
                <Field label={t('customerKyc.f.tradeName')} value={d.trade_name} onChange={(e) => set('trade_name', e.target.value)} disabled={disabled} />
                <Field label={t('customerKyc.f.pan')} className="mono" maxLength={10} value={d.pan} onChange={(e) => set('pan', e.target.value.toUpperCase())} error={errors.pan} help={gstin.length >= 12 ? t('customerKyc.panFromGstin') : undefined} disabled={disabled} />
                <SelectField label={t('customerKyc.f.type')} value={d.customer_type} onChange={(e) => set('customer_type', e.target.value)} options={CUSTOMER_TYPES.map((x) => ({ value: x, label: t(`customersList.type.${x}`) }))} disabled={disabled} />
                <SelectField label={t('customerKyc.f.gstStatus')} value={d.gst_status} onChange={(e) => set('gst_status', e.target.value)} options={GST_STATUSES.map((x) => ({ value: x, label: t(`customersList.gstStatus.${x}`) }))} disabled={disabled || Boolean(gstin)} />
                <Field label={t('customerKyc.f.udyam')} className="mono" placeholder="UDYAM-XX-00-0000000" value={d.udyam_no} onChange={(e) => set('udyam_no', e.target.value.toUpperCase())} error={errors.udyam_no} disabled={disabled} />
              </Grid3>
            </div>
          </Card>

          <Card title={t('customerKyc.addresses')}>
            <FieldGrid cols={1}>
              <Field label={t('customerKyc.f.address')} value={d.address} onChange={(e) => set('address', e.target.value)} disabled={disabled} />
            </FieldGrid>
            <div style={{ marginTop: 12 }}>
              <Grid3>
                <Field label={t('customerKyc.f.city')} value={d.city} onChange={(e) => set('city', e.target.value)} disabled={disabled} />
                <Field label={t('customerKyc.f.pincode')} className="mono" inputMode="numeric" maxLength={6} value={d.pincode} onChange={(e) => set('pincode', e.target.value.replace(/\D/g, ''))} error={errors.pincode} disabled={disabled} />
                <SelectField
                  label={t('customerKyc.f.state')}
                  value={d.state_code}
                  onChange={(e) => set('state_code', e.target.value)}
                  placeholder={t('customerKyc.choose')}
                  options={STATE_CODES.map((c) => ({ value: c, label: `${t(`customersList.states.${c}`)} (${c})` }))}
                  disabled={disabled || gstin.length >= 2}
                />
                <Field label={t('customerKyc.f.lat')} className="mono" inputMode="decimal" value={d.lat} onChange={(e) => set('lat', e.target.value)} error={errors.lat} help={t('customerKyc.pinHelp')} disabled={disabled} />
                <Field label={t('customerKyc.f.lng')} className="mono" inputMode="decimal" value={d.lng} onChange={(e) => set('lng', e.target.value)} error={errors.lng} disabled={disabled} />
              </Grid3>
            </div>
            <div style={{ marginTop: 14, padding: 14, border: '1px dashed var(--sf-line)', borderRadius: 8 }}>
              <strong style={{ fontSize: 13 }}>{t('customerKyc.shipTo')}</strong>
              <p className="k" style={{ margin: '4px 0 0' }}>
                {t('customerKyc.shipToHelp')}
              </p>
              {deliveries.length > 0 ? (
                <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13 }}>
                  {deliveries.map((a) => (
                    <li key={a.id}>
                      {a.line1}
                      {a.city ? `, ${a.city}` : ''} {a.pincode ? <span className="mono">{a.pincode}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {party && canSave ? <ShipToForm partyId={party.id} /> : null}
            </div>
          </Card>

          <Card title={t('customerKyc.contactsCredit')}>
            <Grid3>
              <Field label={t('customerKyc.f.contactName')} value={d.contact_name} onChange={(e) => set('contact_name', e.target.value)} disabled={disabled} />
              <Field label={t('customerKyc.f.whatsapp')} className="mono" prefix="+91" inputMode="tel" value={d.whatsapp} onChange={(e) => set('whatsapp', mobileDigits(e.target.value))} error={errors.whatsapp} disabled={disabled} />
              <SelectField label={t('customerKyc.f.language')} value={d.language} onChange={(e) => set('language', e.target.value)} options={CONTACT_LANGUAGES.map((x) => ({ value: x, label: t(`customersList.language.${x}`) }))} disabled={disabled} />
            </Grid3>
            <div style={{ margin: '12px 0' }}>
              <Checkbox label={t('customerKyc.f.consent')} hint={t('customerKyc.consentHint')} checked={d.consent} onChange={(e) => set('consent', e.target.checked)} disabled={disabled || !d.whatsapp} />
            </div>
            <Grid3>
              <Field label={t('customerKyc.f.beat')} value={d.beat} onChange={(e) => set('beat', e.target.value)} disabled={disabled} />
              <Field label={t('customerKyc.f.tier')} value={d.tier} onChange={(e) => set('tier', e.target.value)} disabled={disabled} />
              <SelectField
                label={t('customerKyc.f.terms')}
                value={d.credit_term_id}
                onChange={(e) => set('credit_term_id', e.target.value)}
                placeholder={termOptions.length ? t('customerKyc.termsCash') : t('customerKyc.termsNone')}
                options={termOptions.map((x) => ({ value: x.id, label: `${x.label} · ${t('customerKyc.days', { count: x.days })}` }))}
                disabled={disabled}
              />
            </Grid3>
            <p className="k" style={{ marginBottom: 0 }}>
              {t('customerKyc.creditLimitLater')}
            </p>
          </Card>
          {party ? <BankChangeRequests partyId={party.id} card /> : null}
        </div>

        <aside style={{ display: 'flex', flexDirection: 'column', gap: 16 }} aria-label={t('customerKyc.sideLabel')}>
          <DuplicateWarning list={dupes.list} forceOffered={isNew && forceOffered} onForce={() => void save(true)} hrefFor={(id) => `${routeForFile('CustomerKYC')}?party=${id}${companyId ? `&company=${companyId}` : ''}`} />

          <Card title={t('customerKyc.next')}>
            <p style={{ marginTop: 0 }}>
              <strong>{t('customerKyc.nextSubmitLead')}</strong> {t('customerKyc.nextSubmit')}
            </p>
            <p>
              <strong>{t('customerKyc.nextVerifyLead')}</strong> {t('customerKyc.nextVerify')}
            </p>
            <p>
              <strong>{t('customerKyc.nextReviewLead')}</strong> {t('customerKyc.nextReview')}
            </p>
            <div className="sf-alert" data-tone="info" style={{ marginBottom: 12 }}>
              <span>{t('customerKyc.cashOnly')}</span>
            </div>
            <PartyErrorBox error={saveErr} />
            {saved ? (
              <p className="k" role="status">
                {t('common.saved')}
              </p>
            ) : null}
            {canSave ? (
              <Button variant={isNew ? 'primary' : 'secondary'} busy={busy} onClick={() => void save(false)} style={{ width: '100%', marginTop: 8 }}>
                {isNew ? t('customerKyc.saveDraft') : t('common.save')}
              </Button>
            ) : null}
            {party && !readOnly ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
                {status === 'review' && canVerify ? <TextAreaField label={t('customerKyc.kycNote')} value={kycNote} onChange={(e) => setKycNote(e.target.value)} /> : null}
                <PartyErrorBox error={kyc.error} />
                {(status === 'draft' || status === 'rejected') && canSave ? (
                  <Button variant="primary" busy={kyc.isPending} onClick={() => step('review')}>
                    {t('customerKyc.sendForVerification')}
                  </Button>
                ) : null}
                {status === 'review' && canVerify ? (
                  <div className="sf-row" style={{ gap: 8 }}>
                    <Button variant="primary" busy={kyc.isPending && kyc.variables?.p_status === 'verified'} onClick={() => step('verified')}>
                      {t('customerKyc.verify')}
                    </Button>
                    <Button variant="danger" busy={kyc.isPending && kyc.variables?.p_status === 'rejected'} onClick={() => step('rejected')}>
                      {t('customerKyc.reject')}
                    </Button>
                  </div>
                ) : null}
                {status === 'review' && !canVerify ? <p className="k">{t('customerKyc.waitingOffice')}</p> : null}
                {status === 'verified' ? (
                  <p className="k">
                    {t('customerKyc.verifiedOn', { due: party.kyc_refresh_due ? formatDate(party.kyc_refresh_due) : '—' })}
                  </p>
                ) : null}
              </div>
            ) : null}
          </Card>

          <PartyDocuments partyId={party?.id} kinds={CUSTOMER_DOC_KINDS} canUpload={canSave} title={t('customerKyc.documents')} />

          <Card title={t('customerKyc.refundBank')}>
            {party ? <PartyBank partyId={party.id} canEdit={canSave} showRequests={false} /> : <p className="k" style={{ margin: 0 }}>{t('customersList.party.docsAfterSave')}</p>}
          </Card>
        </aside>
      </div>
    </>
  )
}

/** Three equal columns (FieldGrid's auto-fit gives four on wide screens). */
function Grid3({ children }: { children: ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>{children}</div>
}

const STATE_CODES = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21', '22', '23', '24', '26', '27', '29', '30', '31', '32', '33', '34', '35', '36', '37', '38', '97']

/** A delivery site (api.upsert_party_address, kind delivery). */
function ShipToForm({ partyId }: { partyId: string }) {
  const { t } = useTranslation()
  const add = useApiMutation<{ p: Record<string, unknown> }>('upsert_party_address', [['api', 'party_addresses']])
  const [open, setOpen] = useState(false)
  const [a, setA] = useState({ line1: '', city: '', pincode: '', state_code: '' })
  const [err, setErr] = useState<string | undefined>()
  if (!open)
    return (
      <div style={{ marginTop: 10 }}>
        <Button
          size="sm"
          onClick={() => {
            add.reset()
            setOpen(true)
          }}
        >
          {t('customerKyc.addShipTo')}
        </Button>
      </div>
    )
  function submit() {
    if (a.line1.trim().length < 3) return setErr(t('customerKyc.err.address'))
    if (a.pincode && !RE_PIN.test(a.pincode)) return setErr(t('customerKyc.err.pincode'))
    setErr(undefined)
    add.mutate(
      { p: { party_id: partyId, kind: 'delivery', line1: a.line1.trim(), city: a.city.trim(), pincode: a.pincode, state_code: a.state_code || null } },
      {
        onSuccess: () => {
          setA({ line1: '', city: '', pincode: '', state_code: '' })
          setOpen(false)
        },
      },
    )
  }
  return (
    <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Grid3>
        <Field label={t('customerKyc.f.shipLine')} value={a.line1} onChange={(e) => setA({ ...a, line1: e.target.value })} error={err} />
        <Field label={t('customerKyc.f.city')} value={a.city} onChange={(e) => setA({ ...a, city: e.target.value })} />
        <Field label={t('customerKyc.f.pincode')} className="mono" inputMode="numeric" maxLength={6} value={a.pincode} onChange={(e) => setA({ ...a, pincode: e.target.value.replace(/\D/g, '') })} />
      </Grid3>
      <PartyErrorBox error={add.error} />
      <div className="sf-row" style={{ gap: 8 }}>
        <Button size="sm" variant="primary" busy={add.isPending} onClick={submit}>
          {t('common.save')}
        </Button>
        <Button size="sm" onClick={() => setOpen(false)}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  )
}
