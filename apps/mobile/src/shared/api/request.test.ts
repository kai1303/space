import { createApi, errorText } from './request';

const reply = (status: number, body: unknown) => ({ status, ok: status < 300, json: async () => body }) as unknown as Response;

it('sends JSON and returns the body', async () => {
  const fetch = jest.fn(async (_path: string, _init?: RequestInit) => reply(201, { id: 'w1' }));
  await expect(createApi({ fetch }).request('/workspaces', { name: 'A' })).resolves.toEqual({ id: 'w1' });
  expect(fetch).toHaveBeenCalledWith('/v1/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"A"}' });
});

it('throws the server error code with its status', async () => {
  const fetch = jest.fn(async (_path: string, _init?: RequestInit) => reply(403, { error: 'forbidden' }));
  await expect(createApi({ fetch }).request('/channels/c1/messages')).rejects.toMatchObject({ status: 403, message: 'forbidden' });
});

it('pages through lists and stops at the page bound', async () => {
  const fetch = jest.fn(async (path: string, _init?: RequestInit) => reply(200, { items: [path], next_cursor: 'next' }));
  expect(await createApi({ fetch }).listAll('/workspaces')).toHaveLength(10);
  expect(fetch.mock.calls[1]![0]).toBe('/v1/workspaces?limit=100&after=next');
});

it('formats error codes for people', () => {
  expect(errorText(new Error('not_found'))).toBe('not found');
  expect(errorText('x')).toBe('Something went wrong');
});
