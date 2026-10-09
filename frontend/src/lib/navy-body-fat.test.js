import { describe, expect, it } from 'vitest'
import { estimateNavyBodyFat } from './navy-body-fat.js'

describe('US Navy body-fat estimate', () => {
  it('calculates male and female estimates in inches', () => {
    expect(estimateNavyBodyFat({ sex: 'male', height: 72, waist: 34, neck: 16, unit: 'in' })).toBe(14.6)
    expect(estimateNavyBodyFat({ sex: 'female', height: 65, waist: 30, neck: 13, hip: 38, unit: 'in' })).toBe(28.6)
  })

  it('converts centimeters and returns the same estimate', () => {
    expect(estimateNavyBodyFat({ sex: 'male', height: 182.88, waist: 86.36, neck: 40.64, unit: 'cm' })).toBe(14.6)
  })

  it('requires valid measurements and a positive formula difference', () => {
    expect(estimateNavyBodyFat({ sex: 'male', height: 0, waist: 34, neck: 16, unit: 'in' })).toBeNull()
    expect(estimateNavyBodyFat({ sex: 'male', height: 72, waist: 15, neck: 16, unit: 'in' })).toBeNull()
    expect(estimateNavyBodyFat({ sex: 'female', height: 65, waist: 30, neck: 13, unit: 'in' })).toBeNull()
    expect(estimateNavyBodyFat({ sex: 'other', height: 72, waist: 34, neck: 16, unit: 'in' })).toBeNull()
  })
})