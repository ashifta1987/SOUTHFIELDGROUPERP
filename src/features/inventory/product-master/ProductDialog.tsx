import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { RpcErrorBox } from '@/features/common/RpcErrorBox'
import { Button, Checkbox, Field, FieldGrid, FormDialog, SelectField } from '@/ui'
import { duplicateCandidates, KINDS, labelText, rateText, STATUSES } from './shared'

type Product = ViewRow<'products'>

interface Draft {
  id?: string
  code: string
  name: string
  group_id: string
  family: string
  kind: string
  hsn_code: string
  uom: string
  net_qty: string
  net_qty_uom: string
  pack_size: string
  barcode: string
  licence_no: string
  status: string
  maker: string
  net_qty_text: string
  batch_expiry_rule: string
  company_ids: string[]
}

function toDraft(p: Product | null, defaultCompany?: string): Draft {
  if (!p) {
    return {
      code: '', name: '', group_id: '', family: '', kind: 'finished', hsn_code: '', uom: '', net_qty: '', net_qty_uom: '', pack_size: '',
      barcode: '', licence_no: '', status: 'active', maker: '', net_qty_text: '', batch_expiry_rule: '', company_ids: defaultCompany ? [defaultCompany] : [],
    }
  }
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    group_id: p.group_id ?? '',
    family: p.family ?? '',
    kind: p.kind,
    hsn_code: p.hsn_code ?? '',
    uom: p.uom,
    net_qty: p.net_qty === null ? '' : String(p.net_qty),
    net_qty_uom: p.net_qty_uom ?? '',
    pack_size: p.pack_size ?? '',
    barcode: p.barcode ?? '',
    licence_no: p.licence_no ?? '',
    status: p.status,
    maker: labelText(p.label, 'maker'),
    net_qty_text: labelText(p.label, 'net_qty_text'),
    batch_expiry_rule: labelText(p.label, 'batch_expiry_rule'),
    company_ids: p.company_ids ?? [],
  }
}

/**
 * Add or edit a product through api.upsert_product. A similar name comes back as `masters.possible_duplicate`
 * with the candidates; Admin can open one of them instead or "Create anyway" (p.force = true).
 */
export function ProductDialog({ product, defaultCompany, onClose }: { product: Product | null; defaultCompany?: string; onClose: () => void }) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<Draft>(() => toDraft(product, defaultCompany))
  const [errors, setErrors] = useState<Partial<Record<keyof Draft, string>>>({})
  const save = useApiMutation<{ p: Record<string, unknown> }>('upsert_product', [['api', 'products'], ['api', 'product_groups']])
  const groups = rowsOf(useApiView('product_groups', { order: 'name' }))
  const hsn = rowsOf(useApiView('hsn_codes', { order: 'code' }))
  const uoms = rowsOf(useApiView('uoms', { order: 'code' }))
  const companies = rowsOf(useApiView('companies', { order: 'code' }))
  const dupes = duplicateCandidates(save.error as RpcError | null)
  const chosenHsn = hsn.find((h) => h.code === draft.hsn_code)

  function set<K extends keyof Draft>(k: K, v: Draft[K]) {
    setDraft((d) => ({ ...d, [k]: v }))
  }

  function validate(d: Draft) {
    const e: Partial<Record<keyof Draft, string>> = {}
    if (!d.id && !/^[A-Z0-9][A-Z0-9._/-]{0,31}$/.test(d.code.trim().toUpperCase())) e.code = t('productMaster.err.code')
    if (d.name.trim().length < 2) e.name = t('productMaster.err.name')
    if (!d.uom) e.uom = t('productMaster.err.uom')
    if (d.net_qty && !(Number(d.net_qty) > 0)) e.net_qty = t('productMaster.err.netQty')
    if (d.net_qty && !d.net_qty_uom) e.net_qty_uom = t('productMaster.err.netQtyUom')
    return e
  }

  function submit(force = false) {
    const e = validate(draft)
    setErrors(e)
    if (Object.keys(e).length) return
    const label: Record<string, string> = {}
    if (draft.maker.trim()) label.maker = draft.maker.trim()
    if (draft.net_qty_text.trim()) label.net_qty_text = draft.net_qty_text.trim()
    if (draft.batch_expiry_rule.trim()) label.batch_expiry_rule = draft.batch_expiry_rule.trim()
    const p: Record<string, unknown> = {
      name: draft.name.trim(),
      group_id: draft.group_id,
      family: draft.family.trim(),
      kind: draft.kind,
      hsn_code: draft.hsn_code,
      uom: draft.uom,
      net_qty: draft.net_qty.trim(),
      net_qty_uom: draft.net_qty_uom,
      pack_size: draft.pack_size.trim(),
      barcode: draft.barcode.trim(),
      licence_no: draft.licence_no.trim(),
      status: draft.status,
      label,
      company_ids: draft.company_ids,
    }
    if (draft.id) p.id = draft.id
    else p.code = draft.code.trim().toUpperCase()
    if (force) p.force = true
    save.mutate({ p }, { onSuccess: onClose })
  }

  const kindOptions = KINDS.map((k) => ({ value: k, label: t(`productMaster.kind.${k}`) }))
  const uomOptions = uoms.map((u) => ({ value: u.code, label: `${u.code} · ${u.label}` }))

  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={draft.id ? t('productMaster.p.editTitle') : t('productMaster.p.addTitle')}
      description={t('productMaster.p.help')}
      submitLabel={t('common.save')}
      busy={save.isPending}
      onSubmit={() => submit(false)}
      wide
      error={
        dupes ? (
          <div
            className="sf-alert"
            role="alert"
            style={{ background: 'var(--sf-signal-tint)', color: 'var(--sf-signal-ink)', borderLeft: '4px solid var(--sf-signal)', display: 'grid', gap: 8 }}
          >
            <strong>{t('productMaster.dup.title')}</strong>
            <span>{t('productMaster.dup.body')}</span>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {dupes.map((d) => (
                <li key={d.id}>
                  <span className="mono">{d.code}</span> · {d.name}
                </li>
              ))}
            </ul>
            <div>
              <Button type="button" onClick={() => submit(true)} busy={save.isPending}>
                {t('productMaster.dup.force')}
              </Button>
            </div>
          </div>
        ) : (
          <RpcErrorBox error={save.error as RpcError | null} />
        )
      }
    >
      <FieldGrid cols={3}>
        <Field
          label={t('productMaster.f.code')}
          className="mono"
          value={draft.code}
          disabled={Boolean(draft.id)}
          maxLength={32}
          onChange={(e) => set('code', e.target.value.toUpperCase())}
          error={errors.code}
          help={t('productMaster.f.codeHelp')}
        />
        <Field label={t('productMaster.f.name')} value={draft.name} onChange={(e) => set('name', e.target.value)} error={errors.name} />
        <SelectField label={t('productMaster.f.kind')} value={draft.kind} onChange={(e) => set('kind', e.target.value)} options={kindOptions} />
        <SelectField
          label={t('productMaster.f.group')}
          value={draft.group_id}
          onChange={(e) => set('group_id', e.target.value)}
          placeholder={t('productMaster.f.noGroup')}
          options={groups.map((g) => ({ value: g.id, label: g.name }))}
        />
        <Field label={t('productMaster.f.family')} value={draft.family} onChange={(e) => set('family', e.target.value)} />
        <SelectField
          label={t('productMaster.f.status')}
          value={draft.status}
          onChange={(e) => set('status', e.target.value)}
          options={STATUSES.map((s) => ({ value: s, label: t(`productMaster.status.${s}`) }))}
        />
        <SelectField
          label={t('productMaster.f.hsn')}
          value={draft.hsn_code}
          onChange={(e) => set('hsn_code', e.target.value)}
          placeholder={t('productMaster.f.noHsn')}
          options={hsn.map((h) => ({ value: h.code, label: `${h.code} · ${h.description}` }))}
          help={
            chosenHsn
              ? chosenHsn.current_rate === null
                ? t('productMaster.f.hsnNoRate')
                : t('productMaster.f.hsnRate', { rate: rateText(chosenHsn.current_rate) })
              : t('productMaster.f.hsnHelp')
          }
        />
        <SelectField label={t('productMaster.f.uom')} value={draft.uom} onChange={(e) => set('uom', e.target.value)} placeholder={t('productMaster.f.choose')} options={uomOptions} error={errors.uom} />
        <Field label={t('productMaster.f.packSize')} value={draft.pack_size} onChange={(e) => set('pack_size', e.target.value)} />
        <Field label={t('productMaster.f.netQty')} className="mono" inputMode="decimal" value={draft.net_qty} onChange={(e) => set('net_qty', e.target.value)} error={errors.net_qty} />
        <SelectField
          label={t('productMaster.f.netQtyUom')}
          value={draft.net_qty_uom}
          onChange={(e) => set('net_qty_uom', e.target.value)}
          placeholder={t('productMaster.f.choose')}
          options={uomOptions}
          error={errors.net_qty_uom}
        />
        <Field label={t('productMaster.f.barcode')} className="mono" value={draft.barcode} onChange={(e) => set('barcode', e.target.value)} />
      </FieldGrid>

      <fieldset style={{ border: 0, padding: 0, margin: '14px 0 0' }}>
        <legend className="sf-card__title" style={{ fontSize: 14, marginBottom: 8 }}>
          {t('productMaster.f.labelData')}
        </legend>
        <FieldGrid cols={2}>
          <Field label={t('productMaster.f.maker')} value={draft.maker} onChange={(e) => set('maker', e.target.value)} />
          <Field label={t('productMaster.f.netQtyText')} value={draft.net_qty_text} onChange={(e) => set('net_qty_text', e.target.value)} help={t('productMaster.f.netQtyTextHelp')} />
          <Field label={t('productMaster.f.licence')} className="mono" value={draft.licence_no} onChange={(e) => set('licence_no', e.target.value)} help={t('productMaster.f.licenceHelp')} />
          <Field label={t('productMaster.f.batchRule')} value={draft.batch_expiry_rule} onChange={(e) => set('batch_expiry_rule', e.target.value)} help={t('productMaster.f.batchRuleHelp')} />
        </FieldGrid>
      </fieldset>

      <fieldset style={{ border: 0, padding: 0, margin: '14px 0 0' }}>
        <legend className="sf-card__title" style={{ fontSize: 14, marginBottom: 8 }}>
          {t('productMaster.f.companies')}
        </legend>
        <div className="sf-row" style={{ flexWrap: 'wrap', gap: 16 }}>
          {companies.map((c) => (
            <Checkbox
              key={c.id}
              label={c.short_name || c.name}
              checked={draft.company_ids.includes(c.id)}
              onChange={(e) => set('company_ids', e.target.checked ? [...draft.company_ids, c.id] : draft.company_ids.filter((x) => x !== c.id))}
            />
          ))}
        </div>
      </fieldset>
    </FormDialog>
  )
}
