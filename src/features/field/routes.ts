import { createElement } from 'react'
import type { RouteObject } from 'react-router-dom'
import { FieldCollectPage } from './collect/FieldCollectPage'
import { FieldCustomerPage } from './customer/FieldCustomerPage'
import { FieldCustomersPage } from './customers/FieldCustomersPage'
import { FieldEndDayPage } from './end-day/FieldEndDayPage'
import { FieldLibraryPage } from './library/FieldLibraryPage'
import { FieldMyDayPage } from './my-day/FieldMyDayPage'
import { FieldOrderPage } from './order/FieldOrderPage'
import { FieldQueriesPage } from './queries/FieldQueriesPage'

/** Salesman portal screens beyond the home (`/field/today`, routed from PAGE_INVENTORY as SalesmanApp). Phone shell. */
export const FIELD_ROUTES: RouteObject[] = [
  { path: 'field/customers', element: createElement(FieldCustomersPage) },
  { path: 'field/customers/:id', element: createElement(FieldCustomerPage) },
  { path: 'field/customers/:id/order', element: createElement(FieldOrderPage) },
  { path: 'field/customers/:id/collect', element: createElement(FieldCollectPage) },
  { path: 'field/queries', element: createElement(FieldQueriesPage) },
  { path: 'field/library', element: createElement(FieldLibraryPage) },
  { path: 'field/my-day', element: createElement(FieldMyDayPage) },
  { path: 'field/end-day', element: createElement(FieldEndDayPage) },
]
