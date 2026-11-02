import { useRef, type ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useTranslation } from 'react-i18next'
import { Button } from './controls'

/**
 * Confirmation for irreversible actions (posting, closing a day, dispatching, cancelling, restoring).
 * States exactly what will happen; focus starts on Cancel (§UX-6).
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  effect,
  confirmLabel,
  onConfirm,
  busy,
  danger,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  /** The exact effect, e.g. "Posts invoice <no> for <amount> and reduces stock of <n> items" */
  effect: ReactNode
  confirmLabel: ReactNode
  onConfirm: () => void
  busy?: boolean
  danger?: boolean
}) {
  const { t } = useTranslation()
  const cancelRef = useRef<HTMLButtonElement>(null)
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="sf-dialog-overlay" />
        <Dialog.Content
          className="sf-dialog"
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            cancelRef.current?.focus()
          }}
        >
          <Dialog.Title asChild>
            <h2>{title}</h2>
          </Dialog.Title>
          <Dialog.Description asChild>
            <p>{effect}</p>
          </Dialog.Description>
          <div className="sf-dialog__actions">
            <Dialog.Close asChild>
              <Button ref={cancelRef}>{t('common.cancel')}</Button>
            </Dialog.Close>
            <Button variant={danger ? 'danger' : 'primary'} busy={busy} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
