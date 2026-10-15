/** Test-only signals; never pass CI through to browser processes (it changes sandbox behavior). */
export function hostCapabilityTestEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return env['CI'] || env['MIRA_TEST_REQUIRE_HOST_SOCKETS'] === '1' ? { MIRA_TEST_REQUIRE_HOST_SOCKETS: '1' } : {};
}
export function maySkipUnavailableHostSocket(code: string, env: NodeJS.ProcessEnv): boolean {
  return code === 'EPERM' && hostCapabilityTestEnvironment(env)['MIRA_TEST_REQUIRE_HOST_SOCKETS'] !== '1';
}
