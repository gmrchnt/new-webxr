// ─────────────────────────────────────────────────
// UPDATE THESE to match your best.onnx class list
// in the exact order the model was trained on.
// ─────────────────────────────────────────────────
export const CLASS_NAMES = [
  "dent",
  "scratch",
  "crack",
  "glass_shatter",
  "tire_flat",
  "lamp_broken",
];

export const BOX_COLORS = [
  "#00e5a0",
  "#ff4757",
  "#ffa502",
  "#3742fa",
  "#ff6b81",
  "#70a1ff",
];

export function getColor(classId) {
  return BOX_COLORS[classId % BOX_COLORS.length];
}
