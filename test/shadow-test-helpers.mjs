import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

export const silentLog = { info() {}, error() {} };

export function makeClassification(overrides = {}) {
  return {
    sessionId: 'session-1',
    requestId: 'req-1',
    querySource: 'agent:custom',
    model: 'claude-opus-4-6',
    toolCount: 2,
    shadowEligible: true,
    ...overrides,
  };
}

export function makeBody(overrides = {}) {
  return Buffer.from(JSON.stringify({
    model: 'claude-opus-4-6',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ name: 'Read', input_schema: { type: 'object' } }],
    metadata: { user_id: '{"querySource":"agent:custom"}' },
    ...overrides,
  }));
}

export async function makeTempDir(t, prefix = 'shadow-test-') {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  return tempDir;
}
