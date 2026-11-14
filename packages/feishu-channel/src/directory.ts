/** App-identity directory traversal. No user OAuth, full-roster model output or persistent cache. */
export type FeishuUser = { name: string; openId: string; userId?: string };
export type FeishuUserSearch = { users: FeishuUser[]; complete: boolean; reason?: string };
export type DirectoryRequest = (url: string, params: Record<string, string | number>, signal: AbortSignal) => Promise<unknown>;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
export const normalizedName = (value: string) => value.normalize('NFC').trim();
export function directoryUser(value: unknown): FeishuUser | null {
  const user = record(value);
  if (!id(user.open_id) || typeof user.name !== 'string' || !normalizedName(user.name) || user.name.length > 256 || !user.name.isWellFormed() || /[\u0000-\u001f\u007f]/u.test(user.name)) return null;
  return { name: normalizedName(user.name), openId: user.open_id, ...(id(user.user_id) ? { userId: user.user_id } : {}) };
}
class DirectoryFailure extends Error { readonly reason: string; constructor(reason: string) { super(reason); this.reason = reason; } }
export async function searchDirectory(request: DirectoryRequest, query: string, signal: AbortSignal): Promise<FeishuUserSearch> {
  const users = new Map<string, FeishuUser>();
  const departments = new Set<string>();
  const deadline = AbortSignal.timeout(20_000);
  const combined = AbortSignal.any([signal, deadline]);
  let requests = 0;
  const run = async (url: string, params: Record<string, string | number>) => {
    combined.throwIfAborted();
    if (++requests > 100) throw new DirectoryFailure('budget_exceeded');
    const response = record(await request(url, params, combined));
    if (response.code !== 0) throw new DirectoryFailure(response.code === 99991672 || response.code === 99991679 ? 'missing_permissions' : 'directory_failed');
    return record(response.data);
  };
  const pages = async (url: string, params: Record<string, string | number>, visit: (data: Record<string, unknown>) => void) => {
    const seen = new Set<string>(); let token = '';
    do {
      const data = await run(url, { ...params, page_size: 50, ...(token ? { page_token: token } : {}) });
      visit(data);
      if (data.has_more !== undefined && typeof data.has_more !== 'boolean') throw new DirectoryFailure('incomplete_directory');
      if (!data.has_more) return;
      if (!id(data.page_token) || seen.has(data.page_token)) throw new DirectoryFailure('incomplete_directory');
      token = data.page_token; seen.add(token);
    } while (true);
  };
  const add = (raw: unknown) => {
    const user = directoryUser(raw);
    if (!user) throw new DirectoryFailure('incomplete_directory');
    const previous = users.get(user.openId);
    if (previous && previous.name !== user.name) throw new DirectoryFailure('directory_changed');
    users.set(user.openId, user);
    if (users.size > 5000) throw new DirectoryFailure('budget_exceeded');
  };
  const items = (data: Record<string, unknown>, visit: (item: unknown) => void) => {
    if (!Array.isArray(data.items)) throw new DirectoryFailure('incomplete_directory');
    for (const item of data.items) visit(item);
  };
  const addDepartment = (value: unknown) => {
    if (!id(value)) throw new DirectoryFailure('incomplete_directory');
    departments.add(value); if (departments.size > 500) throw new DirectoryFailure('budget_exceeded');
  };
  try {
    // Scope introspection can require a permission which member reads do not.
    // Root access is a separate, server-checked fallback; denial is never treated as an empty roster.
    const directlyAuthorized = new Set<string>(); let scopesAvailable = true; let hasGroups = false;
    try {
      await pages('/open-apis/contact/v3/scopes', { user_id_type: 'open_id', department_id_type: 'open_department_id' }, data => {
        for (const field of ['department_ids', 'user_ids', 'group_ids']) if (data[field] !== undefined && !Array.isArray(data[field])) throw new DirectoryFailure('incomplete_directory');
        for (const value of (data.department_ids ?? []) as unknown[]) addDepartment(value);
        for (const value of (data.user_ids ?? []) as unknown[]) { if (!id(value)) throw new DirectoryFailure('incomplete_directory'); directlyAuthorized.add(value); }
        hasGroups ||= ((data.group_ids ?? []) as unknown[]).length > 0;
      });
    } catch (error) {
      if (!(error instanceof DirectoryFailure) || error.reason !== 'missing_permissions') throw error;
      scopesAvailable = false; departments.clear(); directlyAuthorized.clear(); departments.add('0');
    }
    for (const userId of directlyAuthorized) add((await run(`/open-apis/contact/v3/users/${encodeURIComponent(userId)}`, { user_id_type: 'open_id' })).user);
    const roots = [...departments];
    for (const department of roots) await pages(`/open-apis/contact/v3/departments/${encodeURIComponent(department)}/children`, { department_id_type: 'open_department_id', user_id_type: 'open_id', fetch_child: 'true' }, data => items(data, raw => addDepartment(record(raw).open_department_id)));
    for (const department of departments) await pages('/open-apis/contact/v3/users/find_by_department', { department_id: department, department_id_type: 'open_department_id', user_id_type: 'open_id' }, data => items(data, add));
    // Group-only grants need an explicit, separately verified expansion. Until then partial data cannot authorize a unique-name send.
    if (hasGroups) throw new DirectoryFailure('unexpanded_user_groups');
    if (!scopesAvailable && !departments.has('0')) throw new DirectoryFailure('incomplete_directory');
    return { users: [...users.values()].filter(user => normalizedName(user.name).toLowerCase().includes(normalizedName(query).toLowerCase())), complete: true };
  } catch (error) {
    signal.throwIfAborted();
    return { users: [...users.values()].filter(user => normalizedName(user.name).toLowerCase().includes(normalizedName(query).toLowerCase())), complete: false,
      reason: error instanceof DirectoryFailure ? error.reason : deadline.aborted ? 'budget_exceeded' : 'directory_failed' };
  }
}
