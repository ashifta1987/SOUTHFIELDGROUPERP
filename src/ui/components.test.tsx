import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Amount, Button, ConfirmDialog, DataTable, Field, StatusChip, Tabs, TaxClassChip } from '@/ui'

describe('Amount', () => {
  it('formats with Indian grouping and marks negatives', () => {
    const { container } = render(<Amount value="-1234567.5" rupee />)
    const el = container.querySelector('.sf-amount')!
    expect(el.textContent).toBe('−₹12,34,567.50')
    expect(el.getAttribute('data-negative')).toBe('true')
  })
  it('shows a dash for a missing value', () => {
    render(<Amount value={null} />)
    expect(screen.getByText('—')).toBeInTheDocument()
  })
})

describe('chips', () => {
  it('status chip carries a word and an icon', () => {
    const { container } = render(<StatusChip status="overdue" />)
    expect(screen.getByText('Overdue')).toBeInTheDocument()
    expect(container.querySelector('svg')).not.toBeNull()
  })
  it('without-GST chip shows the reason or asks for CA review', () => {
    render(<TaxClassChip taxClass="withoutGst" />)
    expect(screen.getByText('Without GST · None · CA review')).toBeInTheDocument()
  })
})

describe('Button', () => {
  it('a coming-in-phase button is disabled and explains why', () => {
    render(<Button comingInPhase={2}>Add customer</Button>)
    const b = screen.getByRole('button', { name: /Add customer/ })
    expect(b).toBeDisabled()
    expect(b).toHaveAttribute('title', 'Coming in phase 2')
  })
})

describe('Field', () => {
  it('links the error to the input', () => {
    render(<Field label="GSTIN" error="Must be 15 characters." />)
    const input = screen.getByLabelText('GSTIN')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    const msgId = input.getAttribute('aria-describedby')!
    expect(document.getElementById(msgId)?.textContent).toContain('Must be 15 characters.')
  })
})

describe('Tabs', () => {
  it('supports arrow-key navigation', async () => {
    const onChange = vi.fn()
    render(<Tabs label="t" value="a" onChange={onChange} tabs={[{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }]} />)
    screen.getByRole('tab', { name: 'A' }).focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(onChange).toHaveBeenCalledWith('b')
  })
})

describe('DataTable', () => {
  it('renders the empty state with headers scoped', () => {
    render(<DataTable caption="Demo" rows={[]} rowKey={(r: { id: string }) => r.id} columns={[{ key: 'n', header: 'Name', render: () => null }]} empty="No rows because none were added" />)
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveAttribute('scope', 'col')
    expect(screen.getByText('No rows because none were added')).toBeInTheDocument()
  })
})

describe('ConfirmDialog', () => {
  it('states the effect and focuses Cancel first', async () => {
    render(<ConfirmDialog open onOpenChange={() => undefined} title="Post?" effect="Posts TEST-1 for ₹10.00" confirmLabel="Post" onConfirm={() => undefined} />)
    expect(screen.getByText('Posts TEST-1 for ₹10.00')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
  })
})
