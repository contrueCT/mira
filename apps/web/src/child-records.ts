/** Child pages are newest-first by immutable run association, not child age.
 * A page cursor is the last child ID in its preceding page, so gaps can be
 * inserted immediately after that stable anchor without reordering old pages. */
export function mergeChildPage<T extends { id: string }>(current: T[], incoming: T[], after?: string): T[] {
  const merged = [...current];
  let insertion = after === undefined ? 0 : merged.findIndex(item => item.id === after) + 1;
  if (after !== undefined && insertion === 0) throw new Error('无法核对子任务分页边界');
  for (const item of incoming) {
    const index = merged.findIndex(known => known.id === item.id);
    if (index >= 0) { merged[index] = item; insertion = index + 1; }
    else { merged.splice(insertion, 0, item); insertion++; }
  }
  return merged;
}
