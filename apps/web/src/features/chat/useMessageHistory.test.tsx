import { StrictMode, useEffect } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useMessageHistory } from './useMessageHistory.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('loads history after StrictMode cancels and replays the initial effect', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({
    messages: [], has_older: false, has_newer: false, older_cursor: null, newer_cursor: null, event_cursor: '0',
  }) })));
  function Room() {
    const history = useMessageHistory('/channels/test/messages', () => {});
    useEffect(() => { void history.load('latest'); }, [history.load]);
    return <p role="status">{history.page ? 'History ready' : 'Loading history'}</p>;
  }
  render(<StrictMode><Room /></StrictMode>);
  expect(await screen.findByText('History ready')).toBeTruthy();
});
