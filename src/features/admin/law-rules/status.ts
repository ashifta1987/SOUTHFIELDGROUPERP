import type { ComponentProps } from 'react'
import type { Chip } from '@/ui'

type Tone = ComponentProps<typeof Chip>['tone']

export const STATUSES = ['built', 'planned', 'needs_ca'] as const

/** Status chip for each law rule: word + icon, never colour alone. */
export const STATUS_CHIP: Record<string, { tone: Tone; icon: string }> = {
  built: { tone: 'success', icon: 'check' },
  planned: { tone: 'info', icon: 'clock' },
  needs_ca: { tone: 'signal', icon: 'alert' },
}
