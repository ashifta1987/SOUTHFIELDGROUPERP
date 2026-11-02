import type { ComponentProps } from 'react'
import type { Chip } from '@/ui'

export type Tone = ComponentProps<typeof Chip>['tone']

/** Every event the database may write to audit.user_log, with its chip (word + icon, never colour alone). */
export const EVENTS: Record<string, { tone: Tone; icon: string }> = {
  sign_in: { tone: 'teal', icon: 'check' },
  sign_in_failed: { tone: 'danger', icon: 'cross' },
  sign_out: { tone: 'neutral', icon: 'logout' },
  export: { tone: 'info', icon: 'file' },
  print: { tone: 'info', icon: 'file' },
  view_sensitive: { tone: 'signal', icon: 'lock' },
  rights_changed: { tone: 'signal', icon: 'user' },
  grant_given: { tone: 'success', icon: 'check' },
  grant_revoked: { tone: 'danger', icon: 'ban' },
  grant_used: { tone: 'navy', icon: 'clock' },
  setting_changed: { tone: 'info', icon: 'pencil' },
  user_changed: { tone: 'info', icon: 'user' },
  org_changed: { tone: 'info', icon: 'pencil' },
  admin_action: { tone: 'neutral', icon: 'info' },
}
