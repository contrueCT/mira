import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeScenarioNames, openNativeReplay } from './reply-native-fixture.mts';

// Recorded first-attempt native decisions; no paid API or model call occurs in
// this gate. PostgreSQL, Web composition, tools and restart are all real.
for (const scenario of nativeScenarioNames) {
  test(`native reply decision replay through real PostgreSQL/Web runtime: ${scenario}`, { timeout: 60_000 }, async () => {
    const replay = await openNativeReplay(scenario);
    try {
      const result = await replay.run();
      assert.equal(result.requests.length, replay.trace.steps.length);
      if (scenario === 'select-target' || scenario === 'compact-index' || scenario === 'history-recovery') {
        const selected = await replay.resolveCapture(replay.trace.expectedSource.user);
        const publication = result.items.filter(item => item.reply?.messageId === selected && item.role === 'assistant');
        assert.equal(publication.length, 1);
        assert.equal(publication[0]!.reply!.role, 'user');
        assert.equal(publication[0]!.reply!.text, replay.trace.setup[0]!.userText);
      }
    } finally { await replay.close(); }
  });
}
