import { useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth, useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { RpcErrorBox } from '@/features/common/RpcErrorBox'
import { Button, Card, Checkbox, Chip, EmptyState, Field, FieldGrid, FormDialog, PageHeader, SelectField, Skeleton } from '@/ui'

type FormField = ViewRow<'form_fields'>

const TYPES = ['text', 'number', 'date', 'select', 'checkbox', 'phone', 'email'] as const

interface Draft {
  label: string
  field_key: string
  keyTouched: boolean
  field_type: string
  required: boolean
  company_id: string
  options: string
  sort: string
}
const EMPTY: Draft = { label: '', field_key: '', keyTouched: false, field_type: 'text', required: false, company_id: '', options: '', sort: '100' }

interface EditDraft {
  id: string
  label: string
  required: boolean
  options: string
  sort: string
  active: boolean
  field_type: string
}

/** A label turned into a field key the database accepts (^[a-z_]+$). Only a suggestion; Admin may change it. */
function keyFromLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
}
function splitOptions(s: string): string[] {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
}
function optionsText(o: FormField['options']): string {
  return Array.isArray(o) ? o.map((x) => String(x)).join(', ') : ''
}

/**
 * Forms and fields (`FormFields`): the forms from api.forms and their custom fields from api.form_fields.
 * Admin adds, edits and switches fields off through api.upsert_form_field; the server checks the right and the format.
 */
export function FormFieldsPage() {
  const { t } = useTranslation()
  const can = useCan()
  const { profile } = useAuth()
  const canManage = can('forms.manage') && profile?.view !== 'all-readonly'
  const forms = useApiView('forms', { order: 'label' })
  const companies = useApiView('companies', { order: 'code' })
  const formList = rowsOf(forms)
  const [picked, setPicked] = useState<string>('')
  const formKey = picked || formList[0]?.key || ''
  const form = formList.find((f) => f.key === formKey)
  const fields = useApiView('form_fields', { eq: { form_key: formKey }, order: 'sort', enabled: Boolean(formKey) })
  const list = rowsOf(fields)
  const coList = rowsOf(companies)

  const add = useApiMutation<{ p: Record<string, unknown> }>('upsert_form_field', [['api', 'form_fields'], ['api', 'forms']])
  const edit = useApiMutation<{ p: Record<string, unknown> }>('upsert_form_field', [['api', 'form_fields'], ['api', 'forms']])
  const toggle = useApiMutation<{ p: Record<string, unknown> }>('upsert_form_field', [['api', 'form_fields'], ['api', 'forms']])

  const [draft, setDraft] = useState<Draft>({ ...EMPTY })
  const [errors, setErrors] = useState<Partial<Record<'label' | 'field_key' | 'options', string>>>({})
  const [editing, setEditing] = useState<EditDraft | null>(null)
  const [editErr, setEditErr] = useState<string | undefined>()
  const labelRef = useRef<HTMLInputElement>(null)

  const companyName = (id: string | null) => (id ? (coList.find((c) => c.id === id)?.short_name ?? '—') : t('formFields.bothCompanies'))

  function submitNew(e: FormEvent) {
    e.preventDefault()
    const errs: typeof errors = {}
    const key = draft.field_key.trim()
    if (!draft.label.trim()) errs.label = t('formFields.err.label')
    if (!/^[a-z_]+$/.test(key)) errs.field_key = t('formFields.err.key')
    if (draft.field_type === 'select' && splitOptions(draft.options).length === 0) errs.options = t('formFields.err.options')
    setErrors(errs)
    if (Object.keys(errs).length) return
    const p: Record<string, unknown> = {
      form_key: formKey,
      company_id: draft.company_id || null,
      field_key: key,
      label: draft.label.trim(),
      field_type: draft.field_type,
      required: draft.required,
      options: draft.field_type === 'select' ? splitOptions(draft.options) : [],
      sort: Number.parseInt(draft.sort, 10) || 100,
    }
    add.mutate({ p }, { onSuccess: () => setDraft({ ...EMPTY }) })
  }

  function openEdit(f: FormField) {
    edit.reset()
    setEditErr(undefined)
    setEditing({ id: f.id, label: f.label, required: f.required, options: optionsText(f.options), sort: String(f.sort), active: f.active, field_type: f.field_type })
  }
  function submitEdit() {
    if (!editing) return
    if (!editing.label.trim()) {
      setEditErr(t('formFields.err.label'))
      return
    }
    const p: Record<string, unknown> = {
      id: editing.id,
      label: editing.label.trim(),
      required: editing.required,
      sort: Number.parseInt(editing.sort, 10) || 100,
      active: editing.active,
    }
    if (editing.field_type === 'select') p.options = splitOptions(editing.options)
    edit.mutate({ p }, { onSuccess: () => setEditing(null) })
  }

  return (
    <>
      <PageHeader
        title={t('formFields.title')}
        subtitle={t('formFields.subtitle')}
        actions={
          canManage && formKey ? (
            <Button variant="primary" onClick={() => labelRef.current?.focus()}>
              {t('formFields.addField')}
            </Button>
          ) : null
        }
      />
      {!canManage ? <p className="muted">{t('formFields.readOnly')}</p> : null}

      {forms.isLoading ? (
        <Card>
          <Skeleton height={160} />
        </Card>
      ) : formList.length === 0 ? (
        <Card>
          <EmptyState title={t('formFields.noForms')} />
        </Card>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 220px) 1fr', gap: 16, alignItems: 'start' }}>
          <Card as="div" style={{ padding: 8 }}>
            <nav aria-label={t('formFields.formsNav')}>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                {formList.map((f) => {
                  const active = f.key === formKey
                  return (
                    <li key={f.key}>
                      <button
                        type="button"
                        aria-current={active ? 'true' : undefined}
                        onClick={() => setPicked(f.key)}
                        style={{
                          width: '100%',
                          textAlign: 'left',
                          minHeight: 36,
                          padding: '6px 12px',
                          border: 0,
                          borderRadius: 'var(--sf-radius-input)',
                          background: active ? 'var(--sf-primary-tint)' : 'transparent',
                          color: 'var(--sf-text)',
                          fontWeight: active ? 600 : 400,
                          font: 'inherit',
                          fontSize: 14,
                          cursor: 'pointer',
                        }}
                      >
                        {f.label}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </nav>
          </Card>

          <Card pad={false} labelledBy="ff-form-title">
            <div className="sf-card__pad" style={{ paddingBottom: 8 }}>
              <h2 id="ff-form-title" className="sf-card__title">
                {t('formFields.formTitle', { form: form?.label ?? formKey, count: list.length })}
              </h2>
              <p className="muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
                {t('formFields.builtInNote')}
              </p>
            </div>
            <div className="sf-table-wrap" role="region" aria-label={t('formFields.caption', { form: form?.label ?? formKey })} tabIndex={0}>
              <table className="sf-table" style={{ minWidth: 640 }}>
                <caption className="sr-only">{t('formFields.caption', { form: form?.label ?? formKey })}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('formFields.col.field')}</th>
                    <th scope="col">{t('formFields.col.type')}</th>
                    <th scope="col">{t('formFields.col.required')}</th>
                    <th scope="col">{t('formFields.col.company')}</th>
                    <th scope="col">{t('formFields.col.status')}</th>
                    {canManage ? <th scope="col">{t('formFields.col.admin')}</th> : null}
                  </tr>
                </thead>
                <tbody aria-busy={fields.isLoading || undefined}>
                  {fields.isLoading ? (
                    <tr className="sf-table__state">
                      <td colSpan={canManage ? 6 : 5}>
                        <Skeleton height={40} />
                      </td>
                    </tr>
                  ) : list.length === 0 ? (
                    <tr className="sf-table__state">
                      <td colSpan={canManage ? 6 : 5}>
                        <EmptyState title={t('formFields.emptyTitle')} body={canManage ? t('formFields.emptyBody') : t('formFields.emptyBodyReadOnly')} />
                      </td>
                    </tr>
                  ) : (
                    list.map((f) => (
                      <tr key={f.id} data-field-key={f.field_key}>
                        <td>
                          <span style={{ fontWeight: 600 }}>{f.label}</span>
                          <div className="k" style={{ fontSize: 12 }}>
                            <span className="mono">{f.field_key}</span> · {t('formFields.custom')}
                          </div>
                        </td>
                        <td>
                          {t(`formFields.type.${f.field_type}`, { defaultValue: f.field_type })}
                          {f.field_type === 'select' && optionsText(f.options) ? (
                            <div className="k" style={{ fontSize: 12 }}>
                              {optionsText(f.options)}
                            </div>
                          ) : null}
                        </td>
                        <td>{f.required ? t('common.yes') : t('common.no')}</td>
                        <td>{companyName(f.company_id)}</td>
                        <td>
                          {f.active ? (
                            <Chip tone="teal" icon="check">
                              {t('common.active')}
                            </Chip>
                          ) : (
                            <Chip tone="neutral" icon="ban">
                              {t('common.inactive')}
                            </Chip>
                          )}
                        </td>
                        {canManage ? (
                          <td style={{ whiteSpace: 'nowrap' }}>
                            <span className="sf-row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                              <Button size="sm" aria-label={t('formFields.editFor', { label: f.label })} onClick={() => openEdit(f)}>
                                {t('common.edit')}
                              </Button>
                              <Button
                                size="sm"
                                variant={f.active ? 'danger' : 'secondary'}
                                aria-label={t(f.active ? 'formFields.deactivateFor' : 'formFields.activateFor', { label: f.label })}
                                busy={toggle.isPending && toggle.variables?.p.id === f.id}
                                onClick={() => toggle.mutate({ p: { id: f.id, active: !f.active } })}
                              >
                                {f.active ? t('formFields.deactivate') : t('formFields.activate')}
                              </Button>
                            </span>
                          </td>
                        ) : null}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <RpcErrorBox error={toggle.error as RpcError | null} />

            {canManage ? (
              <form
                onSubmit={submitNew}
                aria-labelledby="ff-new-title"
                style={{ padding: '14px 16px', borderTop: '1px solid var(--sf-line)', background: 'var(--sf-row-group)', display: 'grid', gap: 12 }}
                noValidate
              >
                <h3 id="ff-new-title" style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>
                  {t('formFields.new')}
                </h3>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '10px 14px' }}>
                  <Field
                    ref={labelRef}
                    label={t('formFields.f.label')}
                    placeholder={t('formFields.f.labelPlaceholder')}
                    value={draft.label}
                    error={errors.label}
                    onChange={(e) => setDraft({ ...draft, label: e.target.value, field_key: draft.keyTouched ? draft.field_key : keyFromLabel(e.target.value) })}
                  />
                  <Field
                    label={t('formFields.f.key')}
                    className="mono"
                    value={draft.field_key}
                    error={errors.field_key}
                    help={t('formFields.f.keyHelp')}
                    onChange={(e) => setDraft({ ...draft, field_key: e.target.value.toLowerCase(), keyTouched: true })}
                  />
                  <SelectField
                    label={t('formFields.f.type')}
                    value={draft.field_type}
                    onChange={(e) => setDraft({ ...draft, field_type: e.target.value })}
                    options={TYPES.map((x) => ({ value: x, label: t(`formFields.type.${x}`) }))}
                  />
                  <SelectField
                    label={t('formFields.f.required')}
                    value={draft.required ? 'yes' : 'no'}
                    onChange={(e) => setDraft({ ...draft, required: e.target.value === 'yes' })}
                    options={[
                      { value: 'no', label: t('common.no') },
                      { value: 'yes', label: t('common.yes') },
                    ]}
                  />
                  <SelectField
                    label={t('formFields.f.company')}
                    value={draft.company_id}
                    onChange={(e) => setDraft({ ...draft, company_id: e.target.value })}
                    placeholder={t('formFields.bothCompanies')}
                    options={coList.map((c) => ({ value: c.id, label: c.short_name ?? c.name }))}
                  />
                  <Field label={t('formFields.f.sort')} type="number" inputMode="numeric" min={0} value={draft.sort} onChange={(e) => setDraft({ ...draft, sort: e.target.value })} />
                  {draft.field_type === 'select' ? (
                    <Field
                      label={t('formFields.f.options')}
                      value={draft.options}
                      error={errors.options}
                      help={t('formFields.f.optionsHelp')}
                      onChange={(e) => setDraft({ ...draft, options: e.target.value })}
                    />
                  ) : null}
                </div>
                <RpcErrorBox error={add.error as RpcError | null} />
                <div>
                  <Button type="submit" variant="primary" busy={add.isPending}>
                    {t('formFields.addField')}
                  </Button>
                </div>
              </form>
            ) : null}
          </Card>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }}>
        <Card title={t('formFields.removing.title')}>
          <p style={{ margin: '0 0 8px', fontSize: 13 }}>{t('formFields.removing.p1')}</p>
          <p style={{ margin: 0, fontSize: 13 }}>{t('formFields.removing.p2')}</p>
        </Card>
        <Card title={t('formFields.logged.title')}>
          <p style={{ margin: '0 0 8px', fontSize: 13 }}>{t('formFields.logged.p1')}</p>
          <p style={{ margin: 0, fontSize: 13 }}>{t('formFields.logged.p2')}</p>
        </Card>
      </div>

      <FormDialog
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        title={t('formFields.editTitle')}
        description={t('formFields.editHelp')}
        submitLabel={t('common.save')}
        busy={edit.isPending}
        onSubmit={submitEdit}
        error={<RpcErrorBox error={edit.error as RpcError | null} />}
      >
        {editing ? (
          <FieldGrid>
            <Field label={t('formFields.f.label')} value={editing.label} error={editErr} onChange={(e) => setEditing({ ...editing, label: e.target.value })} />
            <Field label={t('formFields.f.sort')} type="number" inputMode="numeric" min={0} value={editing.sort} onChange={(e) => setEditing({ ...editing, sort: e.target.value })} />
            {editing.field_type === 'select' ? (
              <Field
                label={t('formFields.f.options')}
                value={editing.options}
                help={t('formFields.f.optionsHelp')}
                onChange={(e) => setEditing({ ...editing, options: e.target.value })}
              />
            ) : null}
            <Checkbox label={t('formFields.f.required')} checked={editing.required} onChange={(e) => setEditing({ ...editing, required: e.target.checked })} />
            <Checkbox label={t('formFields.f.active')} checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} />
          </FieldGrid>
        ) : null}
      </FormDialog>
    </>
  )
}
