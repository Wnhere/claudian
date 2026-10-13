/** @jest-environment jsdom */
import { fireEvent, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import type { App } from 'obsidian';

import { appendEditorContext } from '@/core/prompt/editorContext';
import { ComposerContextTray } from '@/features/chat/composer/ComposerContextTray';
import { ComposerSelections } from '@/features/chat/input/ComposerSelections';
import { SelectionController } from '@/features/chat/input/SelectionController';

// Obsidian supplies these DOM helpers; keep the tray and browser selection real.
Object.assign(HTMLElement.prototype, {
  addClass(this: HTMLElement, ...names: string[]) { this.classList.add(...names); },
  removeClass(this: HTMLElement, ...names: string[]) { this.classList.remove(...names); },
  toggleClass(this: HTMLElement, name: string, enabled: boolean) { this.classList.toggle(name, enabled); },
  empty(this: HTMLElement) { this.replaceChildren(); },
});

function fixture(source = '# header\nvalue = "中文"\nprint(value)\nprint(value)\n') {
  const containerEl = document.createElement('div');
  const codeContainer = containerEl.createDiv({ cls: 'code-view-container' });
  const gutter = codeContainer.createDiv({ cls: 'code-view-gutter', text: '1\n2\n3\n4' });
  const code = codeContainer.createEl('pre').createEl('code');
  // Separate Prism-style token nodes, preserving the exact source text.
  for (const text of source.match(/\w+|\W+/g) ?? []) {
    code.createSpan({ cls: 'token', text });
  }
  const sidebar = document.createElement('div');
  const trayEl = sidebar.createDiv();
  const input = sidebar.createEl('textarea', { attr: { 'aria-label': 'Message' } });
  document.body.append(containerEl, sidebar);
  const tray = new ComposerContextTray(trayEl);
  const view = { containerEl, file: { path: 'code/A & B.py' }, getViewType: () => 'code-view', getViewData: () => source };
  const workspace = { getActiveViewOfType: jest.fn().mockReturnValue(null), getMostRecentLeaf: jest.fn().mockReturnValue({ view }) };
  const controller = new SelectionController({ workspace } as unknown as App, tray, input, sidebar);
  const idle = { start() {}, stop() {}, async poll() {}, clear() {}, getContext: () => null };
  const selections = new ComposerSelections({ editor: controller, browser: idle, canvas: idle });
  controller.start();

  function point(offset: number): [Node, number] {
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const length = node.textContent!.length;
      if (offset <= length) return [node, offset];
      offset -= length;
    }
    throw new Error('Offset outside fixture source');
  }
  function select(start: number, end: number, reverse = false) {
    const a = point(start);
    const b = point(end);
    const selection = document.getSelection()!;
    selection.setBaseAndExtent(...(reverse ? b : a), ...(reverse ? a : b));
    controller.poll();
  }
  return { view, code, gutter, input, trayEl, workspace, controller, selections, select, source,
    dispose() { selections.stop(); tray.destroy(); } };
}

let active: ReturnType<typeof fixture>;
afterEach(() => {
  active?.dispose();
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it.each([false, true])('passes the selected repeated code and exact line to prompt context (reverse=%s)', async reverse => {
  active = fixture();
  const start = active.source.lastIndexOf('print(value)');
  active.select(start, start + 'print(value)'.length, reverse);
  expect(active.selections.capture().editorSelection).toEqual({
    mode: 'selection', notePath: 'code/A & B.py', selectedText: 'print(value)', startLine: 4, lineCount: 1,
  });
  expect(appendEditorContext('Explain', active.selections.capture().editorSelection!)).toBe(
    'Explain\n\n<editor_selection path="code/A &amp; B.py" lines="4-4">\n<![CDATA[print(value)]]>\n</editor_selection>',
  );
  const remove = within(active.trayEl).getByRole('button', { name: 'Remove 1 line selected' });
  expect((await axe(remove.parentElement!)).violations).toEqual([]);
  fireEvent.click(remove);
  expect(active.selections.capture()).toEqual({});
});

it.each(['\n', '\r\n'])('counts only touched lines for a selection ending at the next line start (%j)', newline => {
  active = fixture(['# header', 'value = "中文"', 'print(value)', 'last = 0'].join(newline));
  const start = active.source.indexOf('value =');
  const end = active.source.indexOf('last =');
  active.select(start, end);
  expect(active.selections.capture().editorSelection).toMatchObject({
    selectedText: active.source.slice(start, end), startLine: 2, lineCount: 2,
  });
});

it('retains the selected code during sidebar handoff and captures an independent submission snapshot', () => {
  jest.useFakeTimers();
  active = fixture();
  active.select(active.source.indexOf('value ='), active.source.indexOf('print(value)'));
  fireEvent.pointerDown(active.input);
  active.input.focus();
  document.getSelection()?.removeAllRanges();
  active.workspace.getMostRecentLeaf.mockReturnValue({ view: { getViewType: () => 'claudian-view' } } as never);
  jest.advanceTimersByTime(2000);
  active.controller.poll();
  const captured = active.selections.capture();
  expect(captured.editorSelection).toMatchObject({ selectedText: 'value = "中文"\n', startLine: 2, lineCount: 1 });
  active.input.blur();
  active.workspace.getMostRecentLeaf.mockReturnValue({ view: active.view });
  active.select(active.source.lastIndexOf('print(value)'), active.source.length - 1);
  expect(active.selections.capture().editorSelection?.startLine).toBe(4);
  expect(captured.editorSelection?.startLine).toBe(2);
});

it('clears the context when code is deselected or another leaf becomes active', () => {
  active = fixture();
  active.select(9, 14);
  expect(active.controller.hasSelection()).toBe(true);
  document.getSelection()?.removeAllRanges();
  active.controller.poll();
  expect(active.selections.capture()).toEqual({});
  active.select(9, 14);
  active.workspace.getMostRecentLeaf.mockReturnValue({ view: { getViewType: () => 'canvas' } } as never);
  active.controller.poll();
  expect(active.selections.capture()).toEqual({});
});

it.each(['gutter', 'outside', 'other-view', 'stale-source', 'missing-file', 'collapsed'])('does not attach invalid selections (%s)', kind => {
  active = fixture();
  if (kind === 'other-view') active.view.getViewType = () => 'some-other-code-editor';
  if (kind === 'stale-source') active.view.getViewData = () => 'different source';
  if (kind === 'missing-file') active.view.file = null as never;
  active.select(9, kind === 'collapsed' ? 9 : 14);
  if (kind === 'gutter' || kind === 'outside') {
    const range = document.createRange();
    range.selectNodeContents(kind === 'gutter' ? active.gutter : active.code);
    if (kind === 'outside') range.setEndAfter(active.code.parentElement!.parentElement!);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    active.controller.poll();
  }
  expect(active.selections.capture()).toEqual({});
});
