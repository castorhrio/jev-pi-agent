import { describe, expect, it } from 'vitest';
import type { ComponentProps } from 'react';
import { render, screen, within } from '@testing-library/react';
import { ChatLog } from '@renderer/components/ChatLog';
import { I18nProvider } from '@renderer/i18n-context';
import { createFixtureApi } from '@renderer/dev/fixture-bridge';
import type { CommandView, ToolView } from '@renderer/state/session-reducer';

/**
 * The transcript's two honesty rules.
 *
 *  - **Nothing is dropped.** The first implementation drew an assistant message
 *    only when it was the newest one, so a three-turn conversation rendered
 *    three questions and a single answer: the history amputated to its tail,
 *    with no notice and no scroll position that would bring the rest back.
 *  - **Cause precedes conclusion.** Messages, tool calls, commands and notices
 *    are one event stream folded into four arrays; seq is the only clock they
 *    share. Drawing the arrays in declaration order put every tool call below
 *    every message — an agent's answer above the work that produced it, which
 *    inverts exactly the causality this product exists to make checkable.
 *
 * Rendered directly rather than through <App/>: the rules are about the
 * transcript, and mounting the shell for them would make every assertion wait
 * on the whole fixture settling.
 */

function mount(
  props: Partial<ComponentProps<typeof ChatLog>> & {
    messages: ComponentProps<typeof ChatLog>['messages'];
  },
) {
  const fixture = createFixtureApi('default');
  (window as unknown as Record<string, unknown>).ucad = fixture.api;
  return render(
    <I18nProvider api={fixture.api}>
      <ChatLog
        tools={[]}
        commands={[]}
        notices={[]}
        agentName="Universal"
        {...props}
      />
    </I18nProvider>,
  );
}

function tool(seq: number, name: string): ToolView {
  return {
    toolCallId: `tc-${seq}`,
    name,
    origin: 'vendor',
    status: 'ok',
    startedAtSeq: seq,
  };
}

function command(seq: number, line: string): CommandView {
  return {
    commandId: `cmd-${seq}`,
    command: line,
    cwd: '/work',
    output: [],
    exitCode: 0,
    startedAtSeq: seq,
  };
}

describe('the transcript keeps every message', () => {
  it('renders each assistant message, not only the newest', () => {
    mount({
      messages: [
        { id: 'u1', role: 'user', text: '第一个问题', turnId: 't1', seq: 1 },
        { id: 'a1', role: 'assistant', text: '第一个回答', turnId: 't1', seq: 3 },
        { id: 'u2', role: 'user', text: '第二个问题', turnId: 't2', seq: 5 },
        { id: 'a2', role: 'assistant', text: '第二个回答', turnId: 't2', seq: 8 },
      ],
    });

    // Both answers, not just the tail. This is the assertion the old
    // implementation failed while every "it rendered" test stayed green.
    expect(screen.getByText('第一个回答')).toBeTruthy();
    expect(screen.getByText('第二个回答')).toBeTruthy();
  });

  it('marks an interrupted message as interrupted', () => {
    const { container } = mount({
      messages: [
        { id: 'u1', role: 'user', text: '问', turnId: 't1', seq: 1 },
        { id: 'a1', role: 'assistant', text: '答到一半', turnId: 't1', seq: 3, interrupted: true },
      ],
    });

    const interrupted = container.querySelector('.msg.interrupted');
    expect(interrupted?.textContent).toContain('答到一半');
  });
});

describe('the transcript draws cause before conclusion', () => {
  it('puts a tool call between the question and the answer that used it', () => {
    const { container } = mount({
      messages: [
        { id: 'u1', role: 'user', text: '读一下 broker', turnId: 't1', seq: 1 },
        { id: 'a1', role: 'assistant', text: '问题在 profile 依赖了可变对象', turnId: 't1', seq: 9 },
      ],
      tools: [tool(5, 'read_file')],
    });

    const turn = container.querySelector('.turn') as HTMLElement;
    const order = Array.from(turn.children).map((child) => {
      if (child.classList.contains('msg')) return child.classList.contains('user') ? 'user' : 'assistant';
      if (child.classList.contains('tool')) return 'tool';
      return 'head';
    });
    expect(order).toEqual(['head', 'user', 'head', 'tool', 'assistant']);
  });

  it('orders commands and notices on the same clock', () => {
    const { container } = mount({
      messages: [
        { id: 'u1', role: 'user', text: '跑测试', turnId: 't1', seq: 1 },
        { id: 'a1', role: 'assistant', text: '测试通过', turnId: 't1', seq: 12 },
      ],
      commands: [command(4, 'npm test')],
      notices: [{ level: 'warn', code: 'SLOW', message: '适配器响应慢', ts: 'x', seq: 8 }],
    });

    const turn = container.querySelector('.turn') as HTMLElement;
    const labels = Array.from(turn.children).map((child) => {
      if (child.classList.contains('msg')) return child.classList.contains('user') ? 'user' : 'assistant';
      if (child.classList.contains('tool')) return child.textContent?.includes('npm test') ? 'command' : 'tool';
      if (child.classList.contains('notice')) return 'notice';
      return 'head';
    });
    expect(labels).toEqual(['head', 'user', 'head', 'command', 'notice', 'assistant']);
  });
});

describe('the transcript names its speakers', () => {
  it('labels the user and the agent, so no line is unattributed', () => {
    const { container } = mount({
      messages: [
        { id: 'u1', role: 'user', text: '问', turnId: 't1', seq: 1 },
        { id: 'a1', role: 'assistant', text: '答', turnId: 't1', seq: 3 },
      ],
    });

    const turn = container.querySelector('.turn') as HTMLElement;
    const heads = Array.from(turn.querySelectorAll('.turn-head .who')).map((h) => h.textContent);
    expect(heads).toEqual(['你', 'Universal']);
    // And the lines themselves are inside the turn they belong to.
    expect(within(turn).getByText('问')).toBeTruthy();
    expect(within(turn).getByText('答')).toBeTruthy();
  });
});
