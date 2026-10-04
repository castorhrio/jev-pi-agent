/**
 * The §9.4 contract suite, applied to the two runtimes that ship today.
 *
 * The point of running it against shipped adapters is that the suite stops being
 * a document: if a change to `MockAgentAdapter` or the Universal adapter breaks
 * the Injection Contract, emits `seq`, or wedges on cancel, this fails here
 * rather than in a native runtime three milestones from now.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MockAgentAdapter } from '@ucad/adapter-mock';
import { createUniversalAdapter } from '@ucad/adapter-universal';
import { silentLogger } from '@ucad/observability';
import type { AgentSessionHandle, AgentTurnInput, CreateAgentSessionInput } from '@ucad/contracts';
import { describeAdapterContract, makeInjection, type AdapterContractHarness } from './adapter-contract';

function scaffold(): { workspaceRoot: string; configDir: string; dispose: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucad-adapter-contract-'));
  const workspaceRoot = path.join(dir, 'workspace');
  const configDir = path.join(dir, 'config');
  fs.mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(workspaceRoot, 'src', 'index.ts'),
    'export const marker = "contract";\n',
    'utf8',
  );
  return {
    workspaceRoot,
    configDir,
    dispose: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function createInput(workspaceRoot: string): CreateAgentSessionInput {
  return {
    ucadSessionId: 'ses_adapter_contract',
    workspaceId: 'ws_adapter_contract',
    workspaceRoot,
    permissionMode: 'ask',
    trustState: 'trusted',
  };
}

function turnInput(handle: AgentSessionHandle, objective: string): AgentTurnInput {
  return {
    turnId: `turn_${objective.length}`,
    objective,
    injection: makeInjection(),
    permissionMode: 'ask',
  };
}

describeAdapterContract('Mock', (): AdapterContractHarness => {
  const box = scaffold();
  return {
    adapter: new MockAgentAdapter({ latencyMs: 5 }),
    workspaceRoot: box.workspaceRoot,
    configDir: box.configDir,
    injection: makeInjection(),
    createInput: createInput(box.workspaceRoot),
    turnInput,
    // `failOn: 'stream'` is the mock's built-in fault injector: it emits a
    // vendor `error` mid-turn and then ends the turn `failed`. A second
    // instance, because an always-failing adapter cannot also prove that normal
    // streaming works.
    vendorFailure: {
      objective: 'trigger the vendor fault',
      adapter: new MockAgentAdapter({ latencyMs: 5, failOn: 'stream' }),
      expect: 'error_event',
    },
  };
});

describeAdapterContract('Universal', (): AdapterContractHarness => {
  const box = scaffold();
  return {
    adapter: createUniversalAdapter({ logger: silentLogger('adapter-contract') }),
    workspaceRoot: box.workspaceRoot,
    configDir: box.configDir,
    injection: makeInjection(),
    createInput: createInput(box.workspaceRoot),
    turnInput,
    // §9.4 forbids CI from depending on a paid model or personal credentials, so
    // the live round trip is the opt-in tier. Declared here with its reason
    // rather than skipped silently.
    offline: {
      streamsText: false,
      streamsTextUnavailableReason:
        'the Universal adapter calls a real OpenAI-compatible endpoint; with no ' +
        'provider credential configured it correctly produces no text, which is ' +
        'the behaviour NFR-16 requires, not a defect. Verified separately in the ' +
        'opt-in live integration tier.',
    },
    vendorFailure: {
      objective: 'anything',
      expect: 'non_completed_terminal',
    },
  };
});
