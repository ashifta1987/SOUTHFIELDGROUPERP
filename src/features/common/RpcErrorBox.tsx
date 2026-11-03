import { useTranslation } from 'react-i18next'
import type { RpcError } from '@/data/rpc'
import { ErrorRef } from '@/ui'
import { askHelp } from '@/features/help/events'

/** Turns a refused RPC into the rule and the next step, with the error reference (§UX-8). */
export function useRpcMessage() {
  const { t } = useTranslation()
  return (err: RpcError | null | undefined): string | null => {
    if (!err) return null
    if (err.rule) {
      const key = `errors.rules.${err.rule}`
      const msg = t(key)
      if (msg !== key) return msg
    }
    if (err.code === '23505') return t('errors.rules.unique')
    if (err.code === '23514' || err.code === '22P02') return t('errors.invalidValue')
    return t('errors.saveFailed')
  }
}

export function RpcErrorBox({ error }: { error: RpcError | null | undefined }) {
  const { t } = useTranslation()
  const message = useRpcMessage()
  if (!error) return null
  return <ErrorRef message={message(error)} next={t('errors.nextStep')} refId={error.ref} onAskHelp={() => askHelp({ errorCode: error.ref })} />
}
