import { useEffect, useState } from 'react'
import { callApi } from '@/data/rpc'
import { useApiRpc } from '@/data/queries'
import { supabase } from '@/shared/supabase'

/**
 * Shared helpers for the party screens (Customers, Customer KYC, Suppliers). Every check here is a format hint
 * or a read; the database (api.upsert_party, api.check_gstin, api.party_duplicates) decides.
 */

export const CUSTOMER_TYPES = ['retail_shop', 'wholesale', 'distributor', 'supermarket_chain', 'online_marketplace', 'export_buyer', 'private_label', 'agent', 'own_shop'] as const
export const GST_STATUSES = ['registered', 'unregistered', 'composition', 'overseas', 'sez'] as const
export const CONTACT_LANGUAGES = ['en', 'ml', 'hi', 'ta', 'bho'] as const
export const MSME_CATEGORIES = ['micro', 'small', 'medium'] as const
export const CUSTOMER_DOC_KINDS = ['gst_certificate', 'pan', 'trade_licence', 'shop_photo', 'cancelled_cheque', 'credit_application', 'security_cheque', 'udyam', 'other'] as const
export const SUPPLIER_DOC_KINDS = ['gst_certificate', 'pan', 'cancelled_cheque', 'udyam', 'coa', 'msds', 'quality_certificate', 'other'] as const
export const BANK_PROOFS = ['cancelled_cheque', 'penny_drop'] as const

export const RE_GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
export const RE_PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/
export const RE_PIN = /^[1-9][0-9]{5}$/
export const RE_UDYAM = /^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$/
export const RE_MOBILE = /^[6-9][0-9]{9}$/
export const RE_IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/
export const RE_ACCOUNT = /^[0-9]{6,20}$/

/** The 10 digits after +91, as typed (spaces and dashes removed). */
export function mobileDigits(v: string): string {
  return v.replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '').slice(0, 10)
}
export function toWhatsapp(digits: string): string | null {
  return digits ? `+91${digits}` : null
}

/** Value that settles after the user stops typing, so live checks do not fire on every key. */
export function useDebounced<T>(value: T, ms = 400): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms)
    return () => window.clearTimeout(id)
  }, [value, ms])
  return v
}

export interface GstinCheck {
  valid: boolean
  state_code: string
  pan: string
}

/** Live GSTIN check (format and check digit) from api.check_gstin. Runs once 15 characters are typed. */
export function useGstinCheck(gstin: string) {
  const g = useDebounced(gstin.trim().toUpperCase(), 250)
  const q = useApiRpc<GstinCheck>('check_gstin', { p_gstin: g }, g.length === 15)
  const result = g.length === 15 && q.data?.status === 'ready' ? q.data.data : null
  return { result, checking: q.isFetching, settled: g === gstin.trim().toUpperCase() }
}

export interface DuplicateCandidate {
  id: string
  name: string
  gstin: string | null
  reason: 'gstin' | 'pan' | 'phone' | 'same_name' | 'similar_name'
  score: number
}

/** Live duplicate warning (same GSTIN, PAN or phone, or a similar name) from api.party_duplicates. */
export function usePartyDuplicates(input: { name: string; gstin: string; pan: string; phone: string; exclude?: string }) {
  // Debounce a string (stable across renders), not the object itself.
  const key = useDebounced(JSON.stringify([input.name, input.gstin, input.pan, input.phone, input.exclude ?? null]), 450)
  const [rawName, gstin, pan, phone, exclude] = JSON.parse(key) as [string, string, string, string, string | null]
  const d = { gstin, pan, phone, exclude }
  const name = rawName.trim()
  const enabled = name.length >= 3 || d.gstin.length === 15 || d.pan.length === 10 || d.phone.length === 10
  const q = useApiRpc<DuplicateCandidate[]>(
    'party_duplicates',
    { p_name: name, p_gstin: d.gstin || null, p_pan: d.pan || null, p_phone: d.phone ? `+91${d.phone}` : null, p_exclude: d.exclude ?? null },
    enabled,
  )
  const list = enabled && q.data?.status === 'ready' && Array.isArray(q.data.data) ? q.data.data : []
  return { list, loading: q.isFetching }
}

/** Upload a KYC file to the private `kyc` bucket, then record it with api.add_party_document. */
export async function uploadPartyDocument(partyId: string, kind: string, file: File, expiresOn: string | null) {
  const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80)
  const path = `${partyId}/${kind}/${crypto.randomUUID()}-${safe}`
  const { error } = await supabase.storage.from('kyc').upload(path, file, { upsert: false, contentType: file.type || undefined })
  if (error) throw new Error(error.message)
  return callApi('add_party_document', { p_party_id: partyId, p_kind: kind, p_storage_path: path, p_expires_on: expiresOn || null })
}

/** Days from today (IST date string) to a YYYY-MM-DD date; negative when past. */
export function daysUntil(date: string, today: string): number {
  const a = Date.parse(`${today}T00:00:00Z`)
  const b = Date.parse(`${date}T00:00:00Z`)
  return Math.round((b - a) / 86_400_000)
}
