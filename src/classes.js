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
  "#51ff00",
  "#ff0015",
  "#ffa600",
  "#3742fa",
  "#00b6ad",
  "#0c0c0c",
];

export function getColor(classId) {
  return BOX_COLORS[classId % BOX_COLORS.length];
}
