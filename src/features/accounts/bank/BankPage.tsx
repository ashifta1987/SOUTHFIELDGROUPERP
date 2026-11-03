import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth, useCan } from '@/auth/AuthProvider'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { useCompanyChoice } from '@/features/admin/branches/company'
import { Card, EmptyState, PageHeader, Skeleton, Tabs } from '@/ui'
import { Reconcile } from './Reconcile'
import { Setup } from './Setup'

type Tab = 'reconcile' | 'setup'

/**
 * Bank (`BankReco`): reconcile a bank account against its statement (lines imported through api.import_bank_lines,
 * matched with api.bank_match_candidates / api.match_bank_line) and, for Admin, set up cash and bank accounts
 * (api.add_money_account) and the posting rules every posting needs (api.set_posting_rule).
 */
export function BankPage() {
  const { t } = useTranslation()
  const can = useCan()
  const { profile } = useAuth()
  const [params, setParams] = useSearchParams()
  const tab: Tab = params.get('tab') === 'setup' ? 'setup' : 'reconcile'
  const { list, companyId, choose, isLoading } = useCompanyChoice()
  const readOnly = profile?.view === 'all-readonly'

  function setTab(k: Tab) {
    const next = new URLSearchParams(params)
    next.set('tab', k)
    setParams(next, { replace: true })
  }

  return (
    <>
      <PageHeader title={t('bankReco.title')} subtitle={t('bankReco.subtitle')} />
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <Tabs
          label={t('bankReco.tabs')}
          value={tab}
          onChange={setTab}
          controls="bank-panel"
          idBase="bank"
          tabs={[
            { key: 'reconcile', label: t('bankReco.tabReconcile') },
            { key: 'setup', label: t('bankReco.tabSetup') },
          ]}
        />
        <CompanyPicker list={list} value={companyId} onChange={choose} />
      </div>
      <div id="bank-panel" role="tabpanel" aria-labelledby={`bank-tab-${tab}`} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {isLoading ? (
          <Card>
            <Skeleton height={80} />
          </Card>
        ) : !companyId ? (
          <Card>
            <EmptyState title={t('bankReco.noCompany')} />
          </Card>
        ) : tab === 'reconcile' ? (
          <Reconcile companyId={companyId} canImport={!readOnly && can('receipts_payments.create')} onSetup={() => setTab('setup')} />
        ) : (
          <Setup companyId={companyId} canManage={!readOnly && can('settings.manage')} />
        )}
      </div>
    </>
  )
}
