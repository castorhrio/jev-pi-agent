import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@renderer/i18n-context';
import { FileEditor } from '@renderer/components/FileEditor';
import { createFixtureApi } from '@renderer/dev/fixture-bridge';
import type { FileWriteResult, UcadApi } from '@ucad/contracts';

/**
 * The editor's conflict decision is a code, not a sentence.
 *
 * It used to be `/revision|conflict|冲突|已修改/i` against the formatted error.
 * That is a protocol made of prose: translating the app, or rewording one
 * sentence, silently stops the conflict controls from appearing — and the user
 * is left with a plain failure and no way to resolve it.
 *
 * `files.write` now answers a mismatch with a structured `conflict` result
 * keyed by `REVISION_CONFLICT`, so these two tests pin the halves: the code
 * opens the conflict controls, and a rejection that merely *talks about*
 * conflicts stays an ordinary failure.
 */

const CONFLICT: FileWriteResult = {
  revision: 'r2',
  conflict: {
    code: 'REVISION_CONFLICT',
    message: '文件已被其他方修改，请重新加载后再试',
    currentRevision: 'r2',
  },
};

function mountEditor(write: (path: string, content: string) => Promise<FileWriteResult>) {
  const fixture = createFixtureApi('default');
  const writeSpy = vi.fn(write);
  const api = {
    ...fixture.api,
    files: {
      ...fixture.api.files,
      read: async () => ({ content: 'const a = 1;\n', truncated: false, revision: 'r1' }),
      write: writeSpy,
    },
  } as unknown as UcadApi;

  (window as unknown as Record<string, unknown>).ucad = api;
  render(
    <I18nProvider api={api}>
      <FileEditor path="src/a.ts" />
    </I18nProvider>,
  );

  return { writeSpy };
}

async function editAndSave(user: ReturnType<typeof userEvent.setup>) {
  const area = await screen.findByRole('textbox');
  await waitFor(() => expect(area).not.toHaveAttribute('readonly'));
  await user.type(area, 'x');
  await user.click(screen.getByRole('button', { name: '保存' }));
}

describe('the file editor resolves a revision conflict by code', () => {
  it('offers reload and overwrite when the write reports a conflict', async () => {
    const user = userEvent.setup();
    const { writeSpy } = mountEditor(async () => CONFLICT);

    await editAndSave(user);

    expect(await screen.findByText(CONFLICT.conflict!.message)).toBeTruthy();
    expect(screen.getByRole('button', { name: '放弃我的修改并重新载入' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '仍然覆盖' })).toBeTruthy();
    expect(writeSpy).toHaveBeenCalledWith(
      'src/a.ts',
      expect.stringContaining('x'),
      expect.objectContaining({ expectedRevision: 'r1' }),
    );
  });

  it('does not turn a rejection that mentions conflicts into one', async () => {
    const user = userEvent.setup();
    mountEditor(async () => {
      // Every word the old regex looked for, in one ordinary failure.
      throw new Error('revision conflict / 冲突 / 已修改');
    });

    await editAndSave(user);

    // The failure is shown, and it is the ordinary one: no conflict controls.
    expect(await screen.findByText(/revision conflict \/ 冲突 \/ 已修改/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '仍然覆盖' })).toBeNull();
    expect(screen.queryByRole('button', { name: '放弃我的修改并重新载入' })).toBeNull();
  });
});
