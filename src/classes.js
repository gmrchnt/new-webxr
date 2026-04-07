// ─────────────────────────────────────────────────
// UPDATE THESE to match your best.onnx class list
// in the exact order the model was trained on.
// ─────────────────────────────────────────────────
export const CLASS_NAMES = [
  'damage',
];

export const BOX_COLORS = [
  '#00e5a0','#ff4757','#ffa502','#3742fa','#ff6b81','#7bed9f',
  '#70a1ff','#eccc68','#a29bfe','#fd79a8','#00cec9','#e17055',
  '#6c5ce7','#fdcb6e','#fab1a0','#74b9ff','#55efc4','#ff7675',
];

export function getColor(classId) {
  return BOX_COLORS[classId % BOX_COLORS.length];
}
