import { Navigate, type RouteObject } from 'react-router-dom'
import { PartnerHomePage } from './home/PartnerHomePage'
import { InvestorGroupPage } from './group/InvestorGroupPage'
import { PartnerPerformancePage } from './performance/PartnerPerformancePage'
import { PartnerInvestmentPage } from './investment/PartnerInvestmentPage'
import { InvestorWorkingPartnerPage } from './working-partner/InvestorWorkingPartnerPage'
import { InvestorProjectsPage } from './projects/InvestorProjectsPage'
import { InvestorWithdrawPage } from './withdraw/InvestorWithdrawPage'
import { InvestorLoanPage } from './loan/InvestorLoanPage'

export { InvestorShell } from './common/InvestorShell'
export { InvestorSignInPage } from './sign-in/InvestorSignInPage'

/** Investor portal pages under /investor (inside InvestorShell; the sign-in page is routed on its own). */
export const INVESTOR_ROUTES: RouteObject[] = [
  { index: true, element: <Navigate to="/investor/home" replace /> },
  { path: 'home', element: <PartnerHomePage /> },
  { path: 'group', element: <InvestorGroupPage /> },
  { path: 'performance', element: <PartnerPerformancePage /> },
  { path: 'investment', element: <PartnerInvestmentPage /> },
  { path: 'working-partner', element: <InvestorWorkingPartnerPage /> },
  { path: 'projects', element: <InvestorProjectsPage /> },
  { path: 'withdraw', element: <InvestorWithdrawPage /> },
  { path: 'loan', element: <InvestorLoanPage /> },
  { path: '*', element: <Navigate to="/investor/home" replace /> },
]
