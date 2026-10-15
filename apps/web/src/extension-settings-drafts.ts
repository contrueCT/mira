/** Draft keys come from extension schemas, including valid Object.prototype names. */
export function ownDraft<T>(draft: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(draft, key) ? draft[key] : undefined;
}
export function secretUpdates(keys: readonly string[], secrets: Record<string, string>, clear: Record<string, boolean>): Record<string, string | null> {
  return Object.fromEntries(keys.flatMap(key => {
    if (ownDraft(clear, key) === true) return [[key, null]] as Array<[string, string | null]>;
    const value = ownDraft(secrets, key);
    return value ? [[key, value]] : [];
  }));
}
