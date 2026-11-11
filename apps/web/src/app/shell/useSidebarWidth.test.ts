import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useSidebarWidth } from './useSidebarWidth.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('keeps the selected desktop navigation width through a browser split and restores it when space permits', () => {
  vi.stubGlobal('spaceDesktop', { openBrowser: vi.fn() });
  vi.stubGlobal('innerWidth', 1360);
  const { result } = renderHook(useSidebarWidth);
  expect(result.current.sidebarWidth).toBe(309);
  act(() => result.current.setSidebarWidth(350));
  for (const [width, expected] of [[866, 350], [721, 327], [1360, 350]] as const) {
    act(() => {
      vi.stubGlobal('innerWidth', width);
      window.dispatchEvent(new Event('resize'));
    });
    expect(result.current.sidebarWidth).toBe(expected);
  }
});
