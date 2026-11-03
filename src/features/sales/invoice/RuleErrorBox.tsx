import { useTranslation } from 'react-i18next'
import type { RpcError } from '@/data/rpc'
import { RpcErrorBox } from '@/features/common/RpcErrorBox'
import { ErrorRef } from '@/ui'

/**
 * Refusals from the document and money RPCs: rule codes that are not in `errors.rules.*` (gst.*, posting.*,
 * period.*, cash.*, money.*, doc.*) are explained from `invoice.rules.*`; the server's own sentence follows,
 * because it often names the exact thing to fix (e.g. which posting rule is missing). Others fall back to RpcErrorBox.
 */
export function RuleErrorBox({ error, next }: { error: RpcError | null | undefined; next?: string }) {
  const { t } = useTranslation()
  if (!error) return null
  if (error.rule) {
    const key = `invoice.rules.${error.rule}`
    const msg = t(key)
    if (msg !== key) {
      const detail = serverSentence(error.message)
      return <ErrorRef message={detail && detail !== msg ? `${msg} ${t('invoice.rules.serverSays', { detail })}` : msg} next={next ?? t('errors.nextStep')} refId={error.ref} />
    }
  }
  return <RpcErrorBox error={error} />
}

/** The human sentence of a Postgres error (drops a leading "code: " prefix). */
function serverSentence(message: string): string {
  const m = message.trim()
  const i = m.indexOf(': ')
  return i > 0 && /^[a-z_]+$/.test(m.slice(0, i)) ? m.slice(i + 2) : m
}
