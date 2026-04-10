// ─────────────────────────────────────────────────
// Must match best.onnx training order exactly.
// ─────────────────────────────────────────────────
export const CLASS_NAMES = [
  "dent",
  "scratch",
  "crack",
  "glass_shatter",
  "lamp_broken",
  "tire_flat",
];

export const BOX_COLORS = [
  "#00ff0d",
  "#fbff00",
  "#ffa502",
  "#3742fa",
  "#ff0026",
  "#000000",
];

export function getColor(classId) {
  return BOX_COLORS[classId % BOX_COLORS.length];
}
