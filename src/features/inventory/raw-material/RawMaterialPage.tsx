import { useTranslation } from 'react-i18next'
import { ItemStockScreen } from '../common/ItemStockScreen'

/** Raw material (`RawMaterial`): raw, packing and perfumery items with lots, QC hold, reservations and reorder levels. */
export function RawMaterialPage() {
  const { t } = useTranslation()
  return <ItemStockScreen view="raw_material_stock" variant="raw" title={t('rawMaterial.title')} subtitle={t('rawMaterial.subtitle')} />
}
