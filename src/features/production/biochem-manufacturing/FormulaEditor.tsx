import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation } from '@/data/rpc'
import { Button, Field, FieldGrid, FormDialog, SelectField, TextAreaField } from '@/ui'
import { cleanNum, ProductionErrorBox, PROD_REFRESH, useCompanyProducts, type FormulaVersion } from '../biochem-common/biochem'

export type EditorSeed = { mode: 'new' } | { mode: 'version'; version: FormulaVersion } | { mode: 'edit'; version: FormulaVersion }

interface Line {
  key: string
  line_kind: 'bulk' | 'packaging'
  product_id: string
  qty: string
  note: string
}
interface Spec {
  key: string
  parameter: string
  min: string
  max: string
  unit: string
  stage: string
}
const STAGES = ['bulk', 'finished', 'in_process']
let seq = 0
const k = () => `r${++seq}`

/**
 * Write a formula version (draft): a new formula, a new version of an existing one (copied from the version shown), or a
 * change to an own draft. Bulk lines are kg per batch size, packaging lines Nos per pack; QC limits per stage. The
 * server checks units (prod.bulk_by_weight, prod.packaging_in_nos), the pack unit and at least one bulk line.
 */
export function FormulaEditor({ companyId, families, seed, onClose, onSaved }: { companyId: string; families: ViewRow<'process_families'>[]; seed: EditorSeed; onClose: () => void; onSaved: (versionId: string) => void }) {
  const { t } = useTranslation()
  const products = useCompanyProducts(companyId)
  const src = seed.mode === 'new' ? null : seed.version
  const srcLines = useApiView('formula_lines', { eq: { version_id: src?.id }, order: 'line_no', enabled: Boolean(src) })
  const [productId, setProductId] = useState('')
  const [familyId, setFamilyId] = useState(families[0]?.id ?? '')
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [batchSize, setBatchSize] = useState(src ? String(src.batch_size) : '')
  const [fill, setFill] = useState(src?.fill_qty_g !== null && src?.fill_qty_g !== undefined ? String(src.fill_qty_g) : '')
  const [notes, setNotes] = useState(seed.mode === 'edit' ? (src?.notes ?? '') : '')
  const [edited, setEdited] = useState<Line[] | null>(src ? null : [{ key: k(), line_kind: 'bulk', product_id: '', qty: '', note: '' }])
  const [spec, setSpec] = useState<Spec[]>(() =>
    src && Array.isArray(src.qc_spec)
      ? (src.qc_spec as { parameter?: string; min?: number | null; max?: number | null; unit?: string | null; stage?: string | null }[]).map((s) => ({
          key: k(),
          parameter: s.parameter ?? '',
          min: s.min === null || s.min === undefined ? '' : String(s.min),
          max: s.max === null || s.max === undefined ? '' : String(s.max),
          unit: s.unit ?? '',
          stage: s.stage ?? 'bulk',
        }))
      : [],
  )
  const [hint, setHint] = useState<string | null>(null)
  const save = useApiMutation<{ p: Record<string, unknown> }, { version_id: string; version: number }>('save_formula_version', PROD_REFRESH)

  // Until edited, the lines are those of the version shown (a new version starts from the one in force).
  const srcRows = rowsOf(srcLines)
  const lines: Line[] =
    edited ?? (srcRows.length ? srcRows.map((l) => ({ key: l.id, line_kind: l.line_kind as 'bulk' | 'packaging', product_id: l.product_id, qty: String(l.qty), note: l.note ?? '' })) : [{ key: 'first', line_kind: 'bulk', product_id: '', qty: '', note: '' }])
  const setLines = (fn: (ls: Line[]) => Line[]) => setEdited(fn(lines))

  const options = [{ value: '', label: t('biochemManufacturing.ed.chooseItem') }, ...products.list.map((p) => ({ value: p.id, label: `${p.code} · ${p.name} (${p.uom})` }))]
  const upd = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  const updS = (key: string, patch: Partial<Spec>) => setSpec((ss) => ss.map((s) => (s.key === key ? { ...s, ...patch } : s)))

  function submit() {
    setHint(null)
    const size = cleanNum(batchSize)
    if (!size) return setHint(t('biochemManufacturing.ed.sizeHint'))
    const out = lines.filter((l) => l.product_id || l.qty)
    for (const l of out) if (!l.product_id || !cleanNum(l.qty)) return setHint(t('biochemManufacturing.ed.lineHint'))
    const p: Record<string, unknown> = {
      company_id: companyId,
      batch_size: size,
      fill_qty_g: fill.trim() ? cleanNum(fill) : null,
      notes: notes.trim() || null,
      qc_spec: spec
        .filter((s) => s.parameter.trim())
        .map((s) => ({ parameter: s.parameter.trim(), min: s.min.trim() === '' ? null : Number(s.min), max: s.max.trim() === '' ? null : Number(s.max), unit: s.unit.trim() || null, stage: s.stage })),
      lines: out.map((l) => ({ line_kind: l.line_kind, product_id: l.product_id, qty: cleanNum(l.qty), note: l.note.trim() || null })),
    }
    if (seed.mode === 'new') Object.assign(p, { product_id: productId || null, family_id: familyId || null, code: code.trim(), name: name.trim() || null })
    else if (seed.mode === 'version') p.formula_id = seed.version.formula_id
    else p.version_id = seed.version.id
    save.mutate(
      { p },
      {
        onSuccess: (r) => {
          onSaved(r.version_id)
          onClose()
        },
      },
    )
  }

  const title = seed.mode === 'new' ? t('biochemManufacturing.ed.newTitle') : seed.mode === 'version' ? t('biochemManufacturing.ed.versionTitle', { code: seed.version.formula_code }) : t('biochemManufacturing.ed.editTitle', { code: seed.version.formula_code, v: seed.version.version })

  return (
    <FormDialog
      open
      wide
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={title}
      description={t('biochemManufacturing.ed.hint')}
      submitLabel={t('biochemManufacturing.ed.save')}
      busy={save.isPending}
      error={
        <>
          {hint ? (
            <p role="alert" className="sf-alert" data-tone="danger" style={{ margin: 0 }}>
              {hint}
            </p>
          ) : null}
          <ProductionErrorBox error={save.error} />
        </>
      }
      onSubmit={submit}
    >
      {seed.mode === 'new' ? (
        <FieldGrid cols={2}>
          <SelectField label={t('biochemManufacturing.ed.product')} value={productId} onChange={(e) => setProductId(e.target.value)} options={options} help={t('biochemManufacturing.ed.productHelp')} />
          <SelectField label={t('biochemManufacturing.ed.family')} value={familyId} onChange={(e) => setFamilyId(e.target.value)} options={families.map((f) => ({ value: f.id, label: `${f.code} · ${f.name}` }))} />
          <Field label={t('biochemManufacturing.ed.code')} value={code} onChange={(e) => setCode(e.target.value)} required />
          <Field label={t('biochemManufacturing.ed.name')} value={name} onChange={(e) => setName(e.target.value)} />
        </FieldGrid>
      ) : null}
      <FieldGrid cols={3}>
        <Field label={t('biochemManufacturing.ed.batchSize')} inputMode="decimal" value={batchSize} onChange={(e) => setBatchSize(e.target.value)} required />
        <Field label={t('biochemManufacturing.ed.fill')} inputMode="decimal" value={fill} onChange={(e) => setFill(e.target.value)} help={t('biochemManufacturing.ed.fillHelp')} />
      </FieldGrid>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ fontWeight: 600, marginBottom: 6 }}>{t('biochemManufacturing.ed.lines')}</legend>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {lines.map((l, i) => (
            <div key={l.key} style={{ display: 'grid', gridTemplateColumns: '130px 1fr 110px 1fr auto', gap: 8, alignItems: 'end' }}>
              <SelectField label={t('biochemManufacturing.ed.kindN', { n: i + 1 })} value={l.line_kind} onChange={(e) => upd(l.key, { line_kind: e.target.value as 'bulk' | 'packaging' })} options={['bulk', 'packaging'].map((x) => ({ value: x, label: t(`biochemManufacturing.lineKind.${x}`) }))} />
              <SelectField label={t('biochemManufacturing.ed.itemN', { n: i + 1 })} value={l.product_id} onChange={(e) => upd(l.key, { product_id: e.target.value })} options={options} />
              <Field label={l.line_kind === 'bulk' ? t('biochemManufacturing.ed.kgN', { n: i + 1 }) : t('biochemManufacturing.ed.nosN', { n: i + 1 })} inputMode="decimal" value={l.qty} onChange={(e) => upd(l.key, { qty: e.target.value })} />
              <Field label={t('biochemManufacturing.ed.noteN', { n: i + 1 })} value={l.note} onChange={(e) => upd(l.key, { note: e.target.value })} />
              <Button size="sm" variant="link" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} aria-label={t('biochemManufacturing.ed.removeN', { n: i + 1 })} disabled={lines.length === 1}>
                {t('biochemManufacturing.ed.remove')}
              </Button>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <Button size="sm" onClick={() => setLines((ls) => [...ls, { key: k(), line_kind: 'bulk', product_id: '', qty: '', note: '' }])}>
            {t('biochemManufacturing.ed.addBulk')}
          </Button>
          <Button size="sm" onClick={() => setLines((ls) => [...ls, { key: k(), line_kind: 'packaging', product_id: '', qty: '', note: '' }])}>
            {t('biochemManufacturing.ed.addPack')}
          </Button>
        </div>
      </fieldset>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ fontWeight: 600, marginBottom: 6 }}>{t('biochemManufacturing.ed.spec')}</legend>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {spec.map((s, i) => (
            <div key={s.key} style={{ display: 'grid', gridTemplateColumns: '1fr 90px 90px 80px 130px auto', gap: 8, alignItems: 'end' }}>
              <Field label={t('biochemManufacturing.ed.paramN', { n: i + 1 })} value={s.parameter} onChange={(e) => updS(s.key, { parameter: e.target.value })} />
              <Field label={t('biochemManufacturing.ed.minN', { n: i + 1 })} inputMode="decimal" value={s.min} onChange={(e) => updS(s.key, { min: e.target.value })} />
              <Field label={t('biochemManufacturing.ed.maxN', { n: i + 1 })} inputMode="decimal" value={s.max} onChange={(e) => updS(s.key, { max: e.target.value })} />
              <Field label={t('biochemManufacturing.ed.unitN', { n: i + 1 })} value={s.unit} onChange={(e) => updS(s.key, { unit: e.target.value })} />
              <SelectField label={t('biochemManufacturing.ed.stageN', { n: i + 1 })} value={s.stage} onChange={(e) => updS(s.key, { stage: e.target.value })} options={STAGES.map((x) => ({ value: x, label: t(`biochemManufacturing.stage.${x}`) }))} />
              <Button size="sm" variant="link" onClick={() => setSpec((ss) => ss.filter((x) => x.key !== s.key))} aria-label={t('biochemManufacturing.ed.removeSpecN', { n: i + 1 })}>
                {t('biochemManufacturing.ed.remove')}
              </Button>
            </div>
          ))}
        </div>
        <Button size="sm" style={{ marginTop: 8 }} onClick={() => setSpec((ss) => [...ss, { key: k(), parameter: '', min: '', max: '', unit: '', stage: 'bulk' }])}>
          {t('biochemManufacturing.ed.addSpec')}
        </Button>
      </fieldset>
      <TextAreaField label={t('biochemManufacturing.ed.notes')} value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
    </FormDialog>
  )
}
