// @vitest-environment happy-dom
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { DEF, useStore } from '../store/useStore.js'
import Measurements from './Measurements.jsx'
import { bwSheet, confirmSheet } from '../sheets.jsx'

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }))
vi.mock('../sheets.jsx', () => ({ bwSheet: vi.fn(), confirmSheet: vi.fn() }))

let host, root
const date = '2026-10-10'
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
  useStore.setState({ user: null, S: { ...structuredClone(DEF), unit: 'kg', lang: 'en',
    bodyweight: [{ d: date, w: 80, t: 100, navy: { sex: 'male', unit: 'cm', height: 183, waist: 90, neck: 40, bodyFat: 18 } }],
    measurements: [], measurementGoals: { waist: 82, neck: 42 },
  } })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<Measurements />))
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('measurement goals and Navy history', () => {
  it('shows Navy readings in both the chart and history with a waist goal', () => {
    expect(host.querySelector('.measure-history')).toBeTruthy()
    expect(host.textContent).not.toContain('No measurements yet')
    expect(host.textContent).toContain('90')
    expect(host.textContent).toContain('82 cm')
    expect(host.textContent).toContain('Body fat 18%')
  })

  it('opens the Navy editor on the original date', () => {
    act(() => host.querySelector('.measure-history button[aria-label="Edit"]').click())
    expect(bwSheet).toHaveBeenCalledWith({ navyExpanded: true, date })
  })

  it('deletes the measurement record without deleting the weigh-in', () => {
    act(() => host.querySelector('.measure-history button[aria-label="Delete"]').click())
    act(() => confirmSheet.mock.calls[0][0].onConfirm())
    expect(useStore.getState().S.bodyweight).toHaveLength(1)
    expect(useStore.getState().S.bodyweight[0].w).toBe(80)
    expect(useStore.getState().S.bodyweight[0].navy).toBeUndefined()
    expect(host.textContent).toContain('No measurements yet')
  })

  it('shows all four goal fields in the profile measurement unit', () => {
    act(() => host.querySelector('button[aria-label="Goal"]').click())
    const fields = [...host.querySelectorAll('.food-goal-field')]
    expect(fields.map(field => field.textContent)).toEqual(['Waist cm', 'Neck cm', 'Hips cm', 'Body fat %'])
    expect(fields.map(field => field.querySelector('input').value)).toEqual(['82', '42', '', ''])
  })
})