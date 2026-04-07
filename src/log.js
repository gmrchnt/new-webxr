/**
 * Damage log — persistent store for all measurements.
 * Entries survive mode switches. Each entry:
 * {
 *   id, mode ('manual'|'auto'), className, confidence?,
 *   lengthM (meters), lengthDisplay, timestamp, bbox?
 * }
 */

let entries = [];
let nextId = 1;
let onChangeCallback = null;

export function addEntry(entry) {
  entries.push({ ...entry, id: nextId++, timestamp: Date.now() });
  if (onChangeCallback) onChangeCallback(getAll());
}

export function removeEntry(id) {
  entries = entries.filter(e => e.id !== id);
  if (onChangeCallback) onChangeCallback(getAll());
}

export function getAll() {
  return [...entries];
}

export function clearAll() {
  entries = [];
  nextId = 1;
  if (onChangeCallback) onChangeCallback(getAll());
}

export function onChange(cb) {
  onChangeCallback = cb;
}

export function getCount() {
  return entries.length;
}
