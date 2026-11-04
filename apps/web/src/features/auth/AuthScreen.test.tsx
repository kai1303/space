import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AuthScreen, SignOutButton } from './AuthScreen.js';
const auth = vi.hoisted(() => ({ signIn: vi.fn(), signUp: vi.fn(), signOut: vi.fn() }));
vi.mock('./auth-client.js', () => ({ authClient: { signIn: { email: auth.signIn }, signUp: { email: auth.signUp }, signOut: auth.signOut } }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it('sends email/password to Better Auth and preserves form values on a rejected login', async () => {
  auth.signIn.mockResolvedValue({ error: { message: 'Invalid email or password' } });
  render(<AuthScreen />);
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'person@example.test' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Incorrect-password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in', exact: true }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Invalid email or password');
  expect(auth.signIn).toHaveBeenCalledWith({ email: 'person@example.test', password: 'Incorrect-password' });
  expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('person@example.test');
});
it('registers a named account with password constraints and clears a successful password', async () => {
  auth.signUp.mockResolvedValue({ data: {}, error: null });
  render(<AuthScreen />);
  fireEvent.click(screen.getByRole('button', { name: 'New here? Create an account' }));
  fireEvent.change(screen.getByLabelText('Your name'), { target: { value: ' Person ' } });
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'person@example.test' } });
  const password = screen.getByLabelText('Password') as HTMLInputElement;
  expect(password.minLength).toBe(12); expect(password.autocomplete).toBe('new-password');
  fireEvent.change(password, { target: { value: 'Long-password-1234' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create account', exact: true }));
  await waitFor(() => expect(auth.signUp).toHaveBeenCalledWith({ name: 'Person', email: 'person@example.test', password: 'Long-password-1234' }));
  await waitFor(() => expect(password.value).toBe(''));
});
it('shows a retryable logout error instead of pretending the session was revoked', async () => {
  auth.signOut.mockRejectedValue(new Error('offline'));
  render(<SignOutButton />);
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Could not sign out. Try again.');
});
