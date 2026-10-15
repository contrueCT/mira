import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import { BrowserManager, BrowserControlError } from './browser-manager.ts';

export function createBrowserTools(manager: BrowserManager, owner: string): AgentTool[] {
  const browser = manager.bind(owner);
  const id = Type.String({ format: 'uuid', description: 'Exact browser id returned in this owner stream. Service restart invalidates it.' });
  const result = (value: unknown, isError = false) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: {}, ...(isError ? { isError } : {}) });
  const call = async (work: () => Promise<unknown>) => {
    try { return result(await work()); }
    catch (error) { if (error instanceof BrowserControlError) return result({ status: 'not_executed', message: error.message }, true); throw error; }
  };
  return [
    { name: 'browser_list', label: 'List managed browsers', description: 'List this stream’s managed browsers and control state without taking screenshots or replaying anything. Human/held means wait for explicit return in Mira Settings → Browser. Main and child handles are separate; browser control is not an action approval system.', parameters: Type.Object({}), execute: async () => result(browser.list()) },
    { name: 'browser_open', label: 'Open managed browser', description: 'Open an agent-browser 0.39.1 managed Chrome/Chromium browser at a HTTP(S) URL. Requires the official CLI and browser already installed. Always use these managed browser tools rather than invoking agent-browser via bash/terminal, so Settings → Browser can give the user exclusive control. OS shell remains unsandboxed. Sessions do not survive service restart. On unknown result inspect browser_list, never replay blindly.', parameters: Type.Object({ url: Type.String({ minLength: 1, maxLength: 8192 }) }), execute: (_id, args) => call(() => browser.open((args as { url: string }).url)) },
    { name: 'browser_command', label: 'Use managed browser', description: 'Run a supported agent-browser argv command in this stream’s browser. First ["snapshot","-i"] returns a new observation number. Every other command must pass that exact number; each command invalidates old refs. Supported: open, back/forward/reload, click/dblclick/hover/focus/check/uncheck/scrollintoview, fill/type, press, select, scroll, get text/html/value/count/box/title/url, tab list/new/close/switch. No shell/config/eval/filesystem/CDP/session flags. Human takeover gates new commands and waits the current command; do not bypass with bash. Return never proves a webpage transaction succeeded; inspect fresh state before any new action. Human frames and typed data are not returned to this tool.', parameters: Type.Object({ id, args: Type.Array(Type.String({ maxLength: 32768 }), { minItems: 1, maxItems: 16 }), observation: Type.Optional(Type.Integer({ minimum: 0 })) }), execute: (_id, args) => { const value = args as { id: string; args: string[]; observation?: number }; return call(() => browser.command(value.id, value.args, value.observation)); } },
    { name: 'browser_close', label: 'Close owned browser', description: 'Explicitly close this stream’s managed browser. This invalidates leases and does not undo webpage effects. Never close a browser the user still needs without considering the conversation.', parameters: Type.Object({ id }), execute: (_id, args) => call(async () => { await browser.close((args as { id: string }).id); return { status: 'closed' }; }) },
  ];
}
