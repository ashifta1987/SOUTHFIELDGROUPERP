/**
 * Opening Southfield Help from anywhere (§HELP-3): any screen, error box or button dispatches a window
 * `sf:help` CustomEvent; the shell's Help panel listens, opens and loads the page or the error reference.
 */
export interface HelpRequest {
  /** Help page slug to open directly */
  page?: string
  /** Error reference shown to the user, e.g. ERR-7F3K2 */
  errorCode?: string
}

export const HELP_EVENT = 'sf:help'

export function askHelp(detail: HelpRequest = {}): void {
  window.dispatchEvent(new CustomEvent<HelpRequest>(HELP_EVENT, { detail }))
}
