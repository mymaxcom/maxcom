// Test helper: narrow a value that a test knows is present (an array element, a map entry, a regex group).
// A missing value fails the test with a clear message instead of a later TypeError.
export function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`expected ${what} to be present`);
  return value;
}
