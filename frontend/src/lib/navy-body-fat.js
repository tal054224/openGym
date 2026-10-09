const INCHES_PER_CM = 1 / 2.54

export function estimateNavyBodyFat({ sex, height, waist, neck, hip, unit }) {
  const values = [height, waist, neck].map(Number)
  if (values.some(value => !Number.isFinite(value) || value <= 0)) return null
  if (unit !== 'cm' && unit !== 'in') return null

  const [heightValue, waistValue, neckValue] = values
  const hipValue = Number(hip)
  if (sex === 'female' && (!Number.isFinite(hipValue) || hipValue <= 0)) return null
  if (sex !== 'male' && sex !== 'female') return null

  const convert = value => unit === 'cm' ? value * INCHES_PER_CM : value
  const heightIn = convert(heightValue)
  const waistIn = convert(waistValue)
  const neckIn = convert(neckValue)
  const hipIn = convert(hipValue)
  const difference = sex === 'male' ? waistIn - neckIn : waistIn + hipIn - neckIn
  if (difference <= 0) return null

  const bodyFat = sex === 'male'
    ? 86.010 * Math.log10(difference) - 70.041 * Math.log10(heightIn) + 36.76
    : 163.205 * Math.log10(difference) - 97.684 * Math.log10(heightIn) - 78.387
  if (!Number.isFinite(bodyFat) || bodyFat < 0 || bodyFat > 100) return null
  return Math.round(bodyFat * 10) / 10
}