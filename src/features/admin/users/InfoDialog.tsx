import type { ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useTranslation } from 'react-i18next'
import { Button } from '@/ui'

/** A read-only explanation dialog (no form): title, body and one close button. */
export function InfoDialog({ open, onOpenChange, title, children, closeLabel }: { open: boolean; onOpenChange: (o: boolean) => void; title: ReactNode; children: ReactNode; closeLabel?: ReactNode }) {
  const { t } = useTranslation()
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="sf-dialog-overlay" />
        <Dialog.Content className="sf-dialog" style={{ width: 'min(620px, calc(100vw - 32px))' }}>
          <Dialog.Title asChild>
            <h2>{title}</h2>
          </Dialog.Title>
          <Dialog.Description asChild>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 14, color: 'var(--sf-text-2)' }}>{children}</div>
          </Dialog.Description>
          <div className="sf-dialog__actions">
            <Dialog.Close asChild>
              <Button variant="primary">{closeLabel ?? t('common.close')}</Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
