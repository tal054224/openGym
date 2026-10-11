export const BODY_MEASUREMENT_KEYS = [
  'neck', 'shoulders', 'chest', 'waist', 'hips', 'abdomen',
  'upperArmLeft', 'upperArmRight', 'forearmLeft', 'forearmRight', 'wristLeft', 'wristRight',
  'thighLeft', 'thighRight', 'calfLeft', 'calfRight', 'ankleLeft', 'ankleRight', 'bodyFat',
];

export function estimateNavyBodyFat({ sex, height, waist, neck, hip, unit }) {
  const values = [height, waist, neck].map(Number);
  if (values.some(value => !Number.isFinite(value) || value <= 0)) return null;
  if (unit !== 'cm' && unit !== 'in') return null;
  const [heightValue, waistValue, neckValue] = values;
  const hipValue = Number(hip);
  if (sex === 'female' && (!Number.isFinite(hipValue) || hipValue <= 0)) return null;
  if (sex !== 'male' && sex !== 'female') return null;
  const convert = value => unit === 'cm' ? value / 2.54 : value;
  const difference = sex === 'male' ? convert(waistValue) - convert(neckValue) : convert(waistValue) + convert(hipValue) - convert(neckValue);
  if (difference <= 0) return null;
  const bodyFat = sex === 'male'
    ? 86.010 * Math.log10(difference) - 70.041 * Math.log10(convert(heightValue)) + 36.76
    : 163.205 * Math.log10(difference) - 97.684 * Math.log10(convert(heightValue)) - 78.387;
  if (!Number.isFinite(bodyFat) || bodyFat < 0 || bodyFat > 100) return null;
  return Math.round(bodyFat * 10) / 10;
}