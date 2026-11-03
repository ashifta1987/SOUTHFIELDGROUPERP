import { useTranslation } from 'react-i18next'
import { ItemStockScreen } from '../common/ItemStockScreen'

/** Component stock (`ComponentStock`): components, machine parts and consumables; available = good stock minus reserved. */
export function ComponentStockPage() {
  const { t } = useTranslation()
  return <ItemStockScreen view="component_stock" variant="component" title={t('componentStock.title')} subtitle={t('componentStock.subtitle')} />
}
