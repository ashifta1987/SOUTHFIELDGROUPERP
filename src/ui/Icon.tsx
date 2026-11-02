import type { SVGProps } from 'react'

/** Stroke icons in the reference style (24×24, round caps). Decorative by default. */
const PATHS: Record<string, string> = {
  chevronRight: 'M9 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M20 20l-3.5-3.5',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4z M10 20a2 2 0 0 0 4 0',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18 M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14 M12 17.5h.01',
  menu: 'M4 6h16 M4 12h16 M4 18h16',
  close: 'M6 6l12 12 M18 6L6 18',
  flow: 'M5 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4 M19 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4 M12 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4 M7 6h10 M6 8l5 8 M18 8l-5 8',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  cross: 'M6 6l12 12 M18 6L6 18',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18 M12 7v5l3 2',
  alert: 'M12 3l10 18H2z M12 10v4 M12 17.5h.01',
  lock: 'M6 11h12v10H6z M8 11V8a4 4 0 0 1 8 0v3',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18 M12 11v6 M12 7.5h.01',
  truck: 'M2 6h11v10H2z M13 10h4l3 3v3h-7z M6 19h.01 M17 19h.01',
  ban: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18 M5.6 5.6l12.8 12.8',
  file: 'M6 3h9l4 4v14H6z M14 3v5h5',
  calendar: 'M4 6h16v14H4z M4 10h16 M8 3v4 M16 3v4 M9 15l2 2 4-4',
  rupee: 'M7 4h10 M7 8h10 M7 4c5 0 7 2 7 4.5S12 13 7 13l8 7',
  user: 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M4 21c1-4 4.2-6 8-6s7 2 8 6',
  receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2z M9 8h6 M9 12h6',
  home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  clipboard: 'M8 4h8v3H8z M6 5H5v16h14V5h-1 M9 12h6 M9 16h6',
  wifiOff: 'M3 3l18 18 M8.5 16.5a5 5 0 0 1 7 0 M5 12.5a10 10 0 0 1 4-2.4 M19 12.5a10 10 0 0 0-3-2 M2 8.5a15 15 0 0 1 5-3 M22 8.5a15 15 0 0 0-10-4 M12 20h.01',
  copy: 'M9 9h11v11H9z M5 15H4V4h11v1',
  logout: 'M15 4h4v16h-4 M10 8l-4 4 4 4 M6 12h10',
  pencil: 'M4 20h4L19 9l-4-4L4 16z',
  plus: 'M12 5v14 M5 12h14',
}

export type IconName = keyof typeof PATHS | string

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName
  size?: number
  strokeWidth?: number
  /** Raw path data, overrides `name` (used for sidebar icons from nav.ts) */
  path?: string
  title?: string
}

export function Icon({ name, size = 18, strokeWidth = 1.9, path, title, ...rest }: IconProps) {
  const d = path ?? PATHS[name] ?? ''
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      <path d={d} />
    </svg>
  )
}

