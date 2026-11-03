import { useEffect, useRef, useState } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useCan } from '@/auth/AuthProvider'
import { callApi, RpcError } from '@/data/rpc'
import { useCompanyChoice } from '@/features/admin/branches/company'
import { PurchaseErrorBox, uploadBillPhoto, usePurchaseRights } from '@/features/purchase/common/purchase'
import { Button, EmptyState, Icon, SelectField, Skeleton, useOnline } from '@/ui'
import type { PhoneOutletContext } from '@/ui/shell/StaffShell'

/**
 * Bill photo on the phone (`BillCapture`): take a photo of a supplier bill (or choose a photo / PDF), it is uploaded to
 * the private `bills` bucket under the company's folder (`<company_id>/<uuid>.<ext>`) and api.create_bill_capture puts
 * it in the Bill photo capture inbox, where it is typed, matched and turned into the bill.
 */
export function BillPhotoPage() {
  const { t } = useTranslation()
  const ctx = useOutletContext<PhoneOutletContext | undefined>()
  const rights = usePurchaseRights()
  const can = useCan()
  const online = useOnline()
  const { list, companyId, choose, isLoading } = useCompanyChoice()
  const camera = useRef<HTMLInputElement>(null)
  const gallery = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<RpcError | null>(null)
  const [uploadErr, setUploadErr] = useState(false)
  const [done, setDone] = useState(false)
  const canUpload = rights.create || rights.bills

  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview)
    }
  }, [preview])

  function pick(f: File | undefined) {
    setDone(false)
    setError(null)
    setUploadErr(false)
    setFile(f ?? null)
    setPreview(f && f.type.startsWith('image/') ? URL.createObjectURL(f) : null)
  }

  async function send() {
    if (!file || !companyId) return
    setBusy(true)
    setError(null)
    setUploadErr(false)
    try {
      const path = await uploadBillPhoto(companyId, file)
      await callApi('create_bill_capture', { p: { company_id: companyId, photo_path: path, source: file.type === 'application/pdf' ? 'pdf' : 'phone' } })
      setDone(true)
      setFile(null)
      setPreview(null)
    } catch (e) {
      if (e instanceof RpcError) setError(e)
      else setUploadErr(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <header className="sf-phone-head">
        <Link to="/me/buying-logistics" className="sf-phone-head__btn" aria-label={t('billPhoto.close')}>
          <Icon name="cross" size={24} />
        </Link>
        <div className="sf-phone-head__text">
          <h1 className="sf-phone-head__name" style={{ margin: 0 }}>
            {t('billPhoto.title')}
          </h1>
          <span className="sf-phone-head__sub">{t('billPhoto.page')}</span>
        </div>
        {ctx?.openHelp ? (
          <button type="button" className="sf-phone-head__btn" aria-label={t('help.open')} onClick={ctx.openHelp}>
            <Icon name="help" size={24} />
          </button>
        ) : null}
      </header>
      <main className="sf-phone-body">
        {isLoading ? (
          <Skeleton height={200} />
        ) : !companyId ? (
          <div className="sf-phone-note">
            <EmptyState title={t('billPhoto.noCompany')} />
          </div>
        ) : !canUpload ? (
          <div className="sf-phone-note">
            <EmptyState title={t('billPhoto.noRightTitle')} body={rights.readOnly ? t('billPhoto.readOnly') : t('billPhoto.noRight')} />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {list.length > 1 ? <SelectField label={t('common.company')} value={companyId} onChange={(e) => choose(e.target.value)} options={list.map((c) => ({ value: c.id, label: c.short_name || c.name }))} /> : null}
            <span className="sf-chip" data-tone="teal" style={{ alignSelf: 'flex-start' }}>
              {t('billPhoto.supplierBill')}
            </span>
            <button
              type="button"
              onClick={() => camera.current?.click()}
              aria-label={file ? t('billPhoto.retake') : t('billPhoto.take')}
              style={{ minHeight: 320, border: '2px dashed var(--sf-line)', borderRadius: 14, background: 'var(--sf-surface)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, padding: 12, cursor: 'pointer', color: 'var(--sf-text-2)' }}
            >
              {preview ? (
                <img src={preview} alt={t('billPhoto.previewAlt')} style={{ maxWidth: '100%', maxHeight: 300, borderRadius: 8 }} />
              ) : file ? (
                <span className="mono">{file.name}</span>
              ) : (
                <>
                  <Icon name="camera" path="M4 8h3l2-3h6l2 3h3v11H4z M12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z" size={36} />
                  <span>{t('billPhoto.frameHint')}</span>
                </>
              )}
            </button>
            <p className="k" style={{ margin: 0, textAlign: 'center' }}>
              {t('billPhoto.frameNote')}
            </p>
            <input ref={camera} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-label={t('billPhoto.take')} onChange={(e) => pick(e.target.files?.[0])} />
            <input ref={gallery} type="file" accept="image/*,application/pdf" className="sr-only" tabIndex={-1} aria-label={t('billPhoto.gallery')} data-testid="bill-file" onChange={(e) => pick(e.target.files?.[0])} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <Button size="touch" onClick={() => gallery.current?.click()}>
                {t('billPhoto.gallery')}
              </Button>
              <Button size="touch" variant="primary" disabled={!file || !online} busy={busy} onClick={() => void send()}>
                {t('billPhoto.send')}
              </Button>
            </div>
            {!online ? (
              <p className="sf-alert" data-tone="signal" style={{ margin: 0 }}>
                {t('billPhoto.offline')}
              </p>
            ) : null}
            <PurchaseErrorBox error={error} />
            {uploadErr ? (
              <p role="alert" className="sf-alert" data-tone="danger" style={{ margin: 0 }}>
                {t('billPhoto.uploadFailed')}
              </p>
            ) : null}
            {done ? (
              <p role="status" className="sf-alert" data-tone="success" style={{ margin: 0, flexDirection: 'column', alignItems: 'flex-start' }}>
                <span>{t('billPhoto.done')}</span>
                {can('purchase.view') || can('purchase_bills.view') ? <Link to={`/purchase/bill-photo-capture?company=${companyId}`}>{t('billPhoto.check')}</Link> : null}
              </p>
            ) : null}
            <p className="k" style={{ margin: 0, textAlign: 'center' }}>
              {t('billPhoto.footnote')}
            </p>
          </div>
        )}
      </main>
    </>
  )
}
