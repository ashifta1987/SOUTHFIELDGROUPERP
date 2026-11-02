import { useRef, type ClipboardEvent, type KeyboardEvent } from 'react'

/** Six single-digit boxes for a one-time code. Digits only; paste fills every box. */
export function OtpBoxes({
  value,
  onChange,
  disabled,
  label,
  className = 'sf-otp__box',
}: {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  label: string
  className?: string
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([])
  const digits = Array.from({ length: 6 }, (_, i) => value[i] ?? '')

  function set(i: number, d: string) {
    const next = digits.slice()
    next[i] = d
    onChange(next.join('').slice(0, 6))
  }
  function onKey(i: number, e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace' && !digits[i] && i > 0) refs.current[i - 1]?.focus()
    if (e.key === 'ArrowLeft' && i > 0) refs.current[i - 1]?.focus()
    if (e.key === 'ArrowRight' && i < 5) refs.current[i + 1]?.focus()
  }
  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6)
    if (text) {
      e.preventDefault()
      onChange(text)
      refs.current[Math.min(text.length, 5)]?.focus()
    }
  }
  return (
    <div className="sf-otp__boxes" role="group" aria-label={label}>
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el
          }}
          className={className}
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          maxLength={1}
          value={d}
          disabled={disabled}
          aria-label={`${label} ${i + 1}`}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, '').slice(-1)
            set(i, v)
            if (v && i < 5) refs.current[i + 1]?.focus()
          }}
          onKeyDown={(e) => onKey(i, e)}
          onPaste={onPaste}
        />
      ))}
    </div>
  )
}

