import { useMemo } from 'react'
import qrcode from 'qrcode-generator'

/**
 * The e-invoice QR printed on the invoice: the signed QR string from the IRP (api.document_final_status → irn.signed_qr),
 * drawn as an SVG path (no HTML injection). Error correction L keeps the long signed payload readable at print size.
 */
export function IrnQr({ value, size = 132, label }: { value: string; size?: number; label: string }) {
  const { path, n } = useMemo(() => {
    const qr = qrcode(0, 'L')
    qr.addData(value, 'Byte')
    qr.make()
    const count = qr.getModuleCount()
    let d = ''
    for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) if (qr.isDark(r, c)) d += `M${c + 2},${r + 2}h1v1h-1z`
    return { path: d, n: count + 4 }
  }, [value])
  return (
    <svg role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges" style={{ background: '#fff', display: 'block' }}>
      <path d={path} fill="#000" />
    </svg>
  )
}
