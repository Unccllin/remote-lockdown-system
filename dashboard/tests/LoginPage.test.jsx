import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { render } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import LoginPage from '../src/pages/LoginPage';
import { setupUser } from './setup';

// Mock the API client
vi.mock('../src/api/client', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

// Mock the setup API
vi.mock('../src/api/setup', () => ({
  setupApi: {
    getStatus: vi.fn(),
  },
}));

import api from '../src/api/client';
import { setupApi } from '../src/api/setup';

function renderWithRouter() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<div data-testid="home">Home</div>} />
        <Route path="/setup" element={<div data-testid="setup">Setup</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('LoginPage username normalisation', () => {
  it('trims a padded username before submitting', async () => {
    renderWithRouter();

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: '  local-admin  ' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret-password' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in|log in|login/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    // The server's charset check would reject " local-admin" and report
    // "invalid characters", which reads like a wrong password. Trim it here.
    expect(api.post).toHaveBeenCalledWith('/auth/login', {
      username: 'local-admin',
      password: 'secret-password',
    });
  });

  it('does not trim the password', async () => {
    renderWithRouter();

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: ' has spaces ' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in|log in|login/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0][1].password).toBe(' has spaces ');
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setupUser('operator');
  setupApi.getStatus.mockResolvedValue({ data: { needsSetup: false } });
  api.post.mockResolvedValue({ data: { token: 'test-jwt-token' } });
});

describe('LoginPage', () => {
  it('renders the login form with title', () => {
    renderWithRouter();
    expect(screen.getByText('DeviceLock Admin')).toBeInTheDocument();
  });

  it('renders username and password inputs', () => {
    renderWithRouter();
    expect(screen.getByPlaceholderText('admin')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('••••••••')).toBeInTheDocument();
  });

  it('renders Sign in button', () => {
    renderWithRouter();
    expect(screen.getByRole('button', { name: /Sign in/i })).toBeInTheDocument();
  });

  it('renders subtitle text', () => {
    renderWithRouter();
    expect(screen.getByText('Remote Device Lockdown System')).toBeInTheDocument();
  });

  it('renders authorized personnel notice', () => {
    renderWithRouter();
    expect(screen.getByText(/Authorized personnel only/i)).toBeInTheDocument();
  });

  it('calls setupApi.getStatus on mount', async () => {
    renderWithRouter();

    await waitFor(() => {
      expect(setupApi.getStatus).toHaveBeenCalled();
    });
  });

  it('submits login form and calls POST /auth/login', async () => {
    renderWithRouter();

    fireEvent.change(screen.getByPlaceholderText('admin'), { target: { value: 'testuser' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: /Sign in/i }));

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/auth/login', {
        username: 'testuser',
        password: 'password123',
      });
    });
  });

  it('stores token in localStorage on successful login', async () => {
    renderWithRouter();

    fireEvent.change(screen.getByPlaceholderText('admin'), { target: { value: 'testuser' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: /Sign in/i }));

    await waitFor(() => {
      expect(localStorage.getItem('token')).toBe('test-jwt-token');
    });
  });

  it('navigates to home after successful login', async () => {
    renderWithRouter();

    fireEvent.change(screen.getByPlaceholderText('admin'), { target: { value: 'testuser' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: /Sign in/i }));

    await waitFor(() => {
      expect(screen.getByTestId('home')).toBeInTheDocument();
    });
  });

  it('stores user info when login response includes user', async () => {
    api.post.mockResolvedValue({
      data: { token: 'test-jwt-token', user: { username: 'testuser', role: 'operator' } },
    });
    renderWithRouter();

    fireEvent.change(screen.getByPlaceholderText('admin'), { target: { value: 'testuser' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: /Sign in/i }));

    await waitFor(() => {
      expect(localStorage.getItem('user')).toBe(JSON.stringify({ username: 'testuser', role: 'operator' }));
    });
  });

  it('shows loading state on submit button while submitting', async () => {
    // Make the API call hang so loading stays true
    api.post.mockReturnValue(new Promise(() => {}));
    renderWithRouter();

    fireEvent.change(screen.getByPlaceholderText('admin'), { target: { value: 'testuser' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: /Sign in/i }));

    await waitFor(() => {
      expect(screen.getByText('Signing in…')).toBeInTheDocument();
    });
  });

  it('does not redirect to setup when needsSetup is false', async () => {
    renderWithRouter();

    await waitFor(() => {
      expect(setupApi.getStatus).toHaveBeenCalled();
    });
    // Should stay on login page
    expect(screen.getByText('DeviceLock Admin')).toBeInTheDocument();
    expect(screen.queryByTestId('setup')).not.toBeInTheDocument();
  });
});
