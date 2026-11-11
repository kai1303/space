import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SignInScreen } from './SignInScreen';

// Testing Library 14 makes render and fireEvent async.
async function fill(email: string, password: string) {
  await fireEvent.changeText(screen.getByLabelText('Email'), email);
  await fireEvent.changeText(screen.getByLabelText('Password'), password);
  await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
}

it('submits the trimmed email and the password', async () => {
  const onSubmit = jest.fn(async (_email: string, _password: string) => {});
  await render(<SignInScreen onSubmit={onSubmit} />);
  await fill(' kai@example.test ', 'Testing-auth-1234!');
  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('kai@example.test', 'Testing-auth-1234!'));
});

it('shows the server error', async () => {
  const onSubmit = jest.fn(async () => { throw new Error('Invalid email or password'); });
  await render(<SignInScreen onSubmit={onSubmit} />);
  await fill('kai@example.test', 'wrong');
  expect(await screen.findByText('Invalid email or password')).toBeTruthy();
});
