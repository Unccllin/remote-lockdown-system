/**
 * SetupPage: the first-run screen must ask for the deployment's setup token.
 *
 * Review S1: `/api/setup/create-admin` used to need no token, so on a fresh deployment the first
 * visitor to find the URL became super-admin — the account that can lock or unlock every machine.
 * The server now requires the token, and this pins the UI half: an empty field is refused before
 * the request, and a filled one is sent as `X-Setup-Token` (never in the body, which is logged more
 * often than headers are).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';

const createAdmin = vi.fn();
const getStatus = vi.fn();

vi.mock('../src/api/setup', () => ({
  setupApi: {
    getStatus: (...args) => getStatus(...args),
    createAdmin: (...args) => createAdmin(...args),
  },
}));

vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import SetupPage from '../src/pages/SetupPage';

function renderPage() {
  return render(
    <MemoryRouter>
      <SetupPage />
    </MemoryRouter>,
  );
}

describe('SetupPage — setup token (review S1)', () => {
  beforeEach(() => {
    createAdmin.mockReset();
    getStatus.mockReset();
    getStatus.mockResolvedValue({ data: { needsSetup: true, setupComplete: false } });
  });

  it('refuses to submit without a setup token', async () => {
    renderPage();
    await waitFor(() => expect(getStatus).toHaveBeenCalled());

    fireEvent.change(screen.getByPlaceholderText('At least 8 characters'), {
      target: { value: 'password123' },
    });
    fireEvent.change(screen.getByPlaceholderText('Re-enter password'), {
      target: { value: 'password123' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create admin account/i }));

    await waitFor(() => expect(screen.getByText(/setup token required/i)).toBeInTheDocument());
    expect(createAdmin).not.toHaveBeenCalled();
  });

  it('sends the token when it is provided', async () => {
    createAdmin.mockResolvedValue({ data: {} });
    renderPage();
    await waitFor(() => expect(getStatus).toHaveBeenCalled());

    fireEvent.change(screen.getByPlaceholderText('At least 8 characters'), {
      target: { value: 'password123' },
    });
    fireEvent.change(screen.getByPlaceholderText('Re-enter password'), {
      target: { value: 'password123' },
    });
    fireEvent.change(screen.getByPlaceholderText(/ADMIN_TOKEN/i), {
      target: { value: 'the-deployment-token' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create admin account/i }));

    await waitFor(() => expect(createAdmin).toHaveBeenCalled());
    // username, password, setup token — the third argument is what becomes X-Setup-Token.
    expect(createAdmin).toHaveBeenCalledWith('admin', 'password123', 'the-deployment-token');
  });
});
