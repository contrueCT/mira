import { supportedThinkingLevels } from '@mira/runtime-pi';
import type { Api, Model, Provider } from '@earendil-works/pi-ai';
import { builtinModels, getBuiltinModelDataGeneratedAt } from '@earendil-works/pi-ai/providers/all';
import { validateBaseUrl } from './model-config.ts';

const protocolNames: Record<string, string> = {
  'openai-completions': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
  'google-generative-ai': 'Google Gemini Generative AI',
  'google-vertex': 'Google Vertex AI',
  'bedrock-converse-stream': 'Amazon Bedrock Converse Stream',
  'azure-openai-responses': 'Azure OpenAI Responses',
  'openai-codex-responses': 'OpenAI ChatGPT/Codex Responses',
  'mistral-conversations': 'Mistral Conversations',
  'pi-messages': 'Pi Messages',
};
export function protocolDescription(api: string): { id: string; name: string } {
  return { id: api, name: protocolNames[api] ?? api };
}
// These implementations require cloud/project/account configuration or subscription
// authentication, deliberately outside the first explicit API-key-only phase.
const deferredProviders = new Set(['amazon-bedrock', 'azure-openai-responses', 'cloudflare-ai-gateway', 'cloudflare-workers-ai', 'github-copilot', 'google-vertex', 'openai-codex', 'radius']);
export function builtinApiKeySupport(provider: Provider): { supported: boolean; explanation: string } {
  if (deferredProviders.has(provider.id) || !provider.auth.apiKey) return { supported: false, explanation: 'Catalog only in this phase: this integration needs OAuth, cloud/account configuration, or another provider-specific login. These setup flows are not implemented.' };
  return { supported: true, explanation: 'Requires an explicitly configured API key for this provider. Catalog presence does not mean credentials, account access, or model entitlement are configured. OAuth and cloud login are not implemented.' };
}
/** Never resolve auth or refresh catalogs while browsing the bundled catalog. */
export function createBuiltinCatalog() {
  return builtinModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
}
export function describeCatalogModel(model: Model<Api>) {
  let catalogBaseUrl: string | null = null;
  try { catalogBaseUrl = validateBaseUrl(model.baseUrl); } catch { /* Cloud placeholders are not request destinations. */ }
  return {
    id: model.id, name: model.name, provider: model.provider, protocol: protocolDescription(model.api),
    catalogBaseUrl, endpointNote: 'Catalog base endpoint, not a guarantee of the final request URL; protocol adapters may append paths or require account configuration.',
    contextWindow: model.contextWindow, maxTokens: model.maxTokens, reasoning: model.reasoning, thinkingLevels: supportedThinkingLevels(model), input: [...model.input],
    pricing: { source: 'bundled-pi-catalog', rates: structuredClone(model.cost), note: 'Catalog estimates may be stale. Zero or absent rates do not establish that a model is free.' },
  };
}
export function listBuiltinCatalog(providerId?: string) {
  const catalog = createBuiltinCatalog();
  const providers = providerId === undefined ? catalog.getProviders() : [catalog.getProvider(providerId)];
  if (providers.some(provider => !provider)) throw Error('Unknown built-in provider');
  return {
    source: '@earendil-works/pi-ai@1.0.2', generatedAt: getBuiltinModelDataGeneratedAt() ?? null,
    providers: providers.map(provider => ({ id: provider!.id, name: provider!.name, apiKeySupport: builtinApiKeySupport(provider!), models: provider!.getModels().map(describeCatalogModel) })),
  };
}
export function getBuiltinCatalogModel(providerId: string, modelId: string) {
  const catalog = createBuiltinCatalog(); const provider = catalog.getProvider(providerId); const model = catalog.getModel(providerId, modelId);
  if (!provider || !model) throw Error('Unknown built-in provider/model');
  return { ...describeCatalogModel(model), apiKeySupport: builtinApiKeySupport(provider) };
}
