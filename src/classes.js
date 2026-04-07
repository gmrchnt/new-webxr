// ─────────────────────────────────────────────────
// Must match best.onnx training order exactly.
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
  "#7bed9f",
];

export function getColor(classId) {
  return BOX_COLORS[classId % BOX_COLORS.length];
}
