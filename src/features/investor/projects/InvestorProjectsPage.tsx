import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useApiMutation } from '@/data/rpc'
import { formatDate, formatIndian } from '@/shared/format'
import { Button, Chip, EmptyState } from '@/ui'
import { REQUEST_KEYS, useInvestorMe, useInvestorProjects, useMyRequests } from '../common/investor'
import { InvestorError, Line, LoadFailed, Loading, NotLinked, PCard, PageTitle, RequestList } from '../common/ui'

interface Args extends Record<string, unknown> {
  p_kind: 'project_offer'
  p: { partner_id: string; project_id: string }
}

const STATUS_TONE: Record<string, 'teal' | 'info' | 'signal' | 'neutral'> = { running: 'teal', being_built: 'info', idea: 'signal', closed: 'neutral' }

/** What Admin chose to show investors about a project: label → value (numbers formatted, text as given). */
function figures(v: unknown): [string, string][] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return []
  return Object.entries(v as Record<string, unknown>).map(([k, x]) => [k.replace(/_/g, ' '), typeof x === 'number' ? formatIndian(x, 0) : String(x ?? '—')])
}

/**
 * Investor portal · Projects (`InvestorProjects`). Projects Admin marked visible to investors (`v_investor_projects`),
 * with only the figures Admin chose to show. "I'm interested" sends a project-offer request to Admin
 * (`submit_partner_request`); a project becomes an investment only with a signed agreement, recorded by Admin.
 */
export function InvestorProjectsPage() {
  const { t } = useTranslation()
  const { me, isLoading: meLoading } = useInvestorMe()
  const projects = useInvestorProjects()
  const requests = useMyRequests()
  const send = useApiMutation<Args, { id: string; doc_no: string; status: string }>('submit_partner_request', REQUEST_KEYS)
  const [sentDoc, setSentDoc] = useState<{ project: string; doc: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  if (meLoading || projects.isLoading) return <Loading />
  if (projects.isError || !me) return <LoadFailed />

  return (
    <>
      <PageTitle title={t('investorProjects.title')} sub={t('investorProjects.sub')} />
      {me.partners.length === 0 ? <NotLinked /> : null}
      <InvestorError error={send.error} />
      {projects.rows.length === 0 && me.partners.length ? <EmptyState title={t('investorProjects.empty')} body={t('investorProjects.emptyNext')} /> : null}
      {projects.rows.map((p) => {
        const partner = me.partners.find((x) => x.company_id === p.company_id)
        const lid = `proj-${p.id}`
        return (
          <PCard key={p.id} labelId={lid} title={p.name} action={<Chip tone={STATUS_TONE[p.status ?? ''] ?? 'neutral'}>{t(`investorProjects.status.${p.status ?? 'idea'}`)}</Chip>}>
            <div>
              <Line label={t('investor.company')}>{p.company_name}</Line>
              {p.started_on ? <Line label={t('investorProjects.since')}>{formatDate(p.started_on)}</Line> : null}
              {figures(p.investor_figures).map(([k, v]) => (
                <Line key={k} label={k}>
                  <span className="mono">{v}</span>
                </Line>
              ))}
            </div>
            {p.summary ? <p style={{ margin: 0, fontSize: 14, color: 'var(--sf-text-2)' }}>{p.summary}</p> : null}
            {sentDoc?.project === p.id ? (
              <div className="sf-phone-note" role="status">
                {t('investor.sent', { doc: sentDoc.doc })}
              </div>
            ) : null}
            {partner && p.id && p.status !== 'closed' ? (
              <Button
                variant="secondary"
                size="touch"
                busy={send.isPending && busy === p.id}
                onClick={() => {
                  setBusy(p.id)
                  send.mutate(
                    { p_kind: 'project_offer', p: { partner_id: partner.partner_id, project_id: p.id as string } },
                    { onSuccess: (r) => setSentDoc({ project: p.id as string, doc: r.doc_no }) },
                  )
                }}
              >
                {t('investorProjects.interested')}
                <span className="sr-only"> · {p.name}</span>
              </Button>
            ) : null}
          </PCard>
        )
      })}
      <RequestList rows={requests.rows} kinds={['project_offer']} loading={requests.isLoading} title={t('investorProjects.mine')} emptyText={t('investorProjects.noneYet')} />
    </>
  )
}
