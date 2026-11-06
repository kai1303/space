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
  expect((await screen.findByRole('alert')).textContent).toContain('Email or password didn’t match.');
  expect(auth.signIn).toHaveBeenCalledWith({ email: 'person@example.test', password: 'Incorrect-password' });
  expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('person@example.test');
});

it('associates rejected credentials with the fields and clears stale feedback on edit', async () => {
  auth.signIn.mockResolvedValue({ error: { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' } });
  render(<AuthScreen />);
  const email = screen.getByLabelText('Email'), password = screen.getByLabelText('Password');
  fireEvent.change(email, { target: { value: 'person@example.test' } });
  fireEvent.change(password, { target: { value: 'Incorrect-password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in', exact: true }));
  const feedback = await screen.findByRole('alert');
  expect(email.getAttribute('aria-invalid')).toBe('true');
  expect(password.getAttribute('aria-describedby')).toContain(feedback.id);
  expect(feedback.textContent).toContain('Check your details and try again.');
  fireEvent.change(password, { target: { value: 'Corrected-password' } });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(password.getAttribute('aria-invalid')).not.toBe('true');
  expect(email).toHaveProperty('value', 'person@example.test');
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

it('announces sign-in progress and prevents changes or duplicate submissions while pending', async () => {
  let finish!: (result: unknown) => void;
  auth.signIn.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  render(<AuthScreen />);
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'person@example.test' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Long-password-1234' } });
  const form = screen.getByLabelText('Email').closest('form')!;
  fireEvent.submit(form);
  expect(screen.getByRole('button', { name: 'Signing in…' })).toHaveProperty('disabled', true);
  expect(screen.getByLabelText('Email')).toHaveProperty('disabled', true);
  fireEvent.submit(form);
  expect(auth.signIn).toHaveBeenCalledTimes(1);
  finish({ error: { message: 'Try again' } });
  await screen.findByRole('alert');
  expect(screen.getByLabelText('Email')).toHaveProperty('disabled', false);
  expect(screen.getByLabelText('Password')).toHaveProperty('value', 'Long-password-1234');
});
