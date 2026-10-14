import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ToolResultMessage } from '@earendil-works/pi-ai';
import { writeWakeInput } from '@mira/workspace';

export const largeToolText = 'single-line-中文😀\\"'.repeat(12_000) + 'FULL_ORIGINAL_TAIL';
export const outputSpool = (root: string) => (runId: string, content: string) => writeWakeInput({ rootDirectory: root, sourceDirectory: process.cwd(), runId, content });
export function outputPath(message: ToolResultMessage): string {
  const notice = message.content.filter(block => block.type === 'text').findLast(block => block.text.includes('Full original result, including all text and metadata:'))?.text ?? '';
  const path = notice.match(/Full original result, including all text and metadata: ("(?:[^"\\]|\\.)*")/u)?.[1];
  assert.ok(path, 'bounded result has an actionable ordinary-file reference');
  return JSON.parse(path) as string;
}
export async function fullOutput(message: ToolResultMessage): Promise<ToolResultMessage> {
  const lines = (await readFile(outputPath(message), 'utf8')).trimEnd().split('\n').map(line => {
    assert.ok(Buffer.byteLength(line) < 8_192, 'even giant single-line inputs have bounded readable file lines');
    return JSON.parse(line);
  });
  const header = lines.shift();
  assert.equal(header.format, 'mira-tool-result-json-chunks-v1');
  const json = lines.map(line => line.text).join('');
  assert.equal(Buffer.byteLength(json), header.bytes);
  assert.equal(createHash('sha256').update(json).digest('hex'), header.sha256);
  return JSON.parse(json) as ToolResultMessage;
}
