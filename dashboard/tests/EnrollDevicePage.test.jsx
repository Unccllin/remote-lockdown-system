import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import EnrollDevicePage from '../src/pages/EnrollDevicePage';
import { setupUser } from './setup';
// Mock the API client
vi.mock('../src/api/client', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

import api from '../src/api/client';

function renderWithRouter() {
  return render(
    <MemoryRouter initialEntries={['/devices/enroll']}>
      <Routes>
        <Route path="/devices/enroll" element={<EnrollDevicePage />} />
        <Route path="/devices" element={<div data-testid="devices-page">Devices</div>} />
      </Routes>
    </MemoryRouter>
  );
}

// A token response 15 minutes in the future
function tokenResponse() {
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  return { token: 'test-enroll-token-abc123', expires_at: expiresAt, expires_in: 900 };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.clearAllTimers();
  localStorage.clear();
  setupUser('operator');
  // Default: no devices
  api.get.mockResolvedValue({ data: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('EnrollDevicePage', () => {
  it('renders the generate token button initially', () => {
    renderWithRouter();
    expect(screen.getByRole('button', { name: /Generate Enrollment Token/i })).toBeInTheDocument();
  });

  it('shows back-to-devices link', () => {
    renderWithRouter();
    expect(screen.getByText(/Back to Devices/i)).toBeInTheDocument();
  });

  it('generates a token and displays it with QR code and command', async () => {
    api.post.mockResolvedValue({ data: tokenResponse() });

    renderWithRouter();

    const btn = screen.getByRole('button', { name: /Generate Enrollment Token/i });
    await fireEvent.click(btn);

    // Token text is displayed
    await waitFor(() => {
      expect(screen.getByTestId('enroll-token-display')).toHaveTextContent('test-enroll-token-abc123');
    });

    // QR code image is rendered
    expect(screen.getByTestId('enroll-qr-code')).toBeInTheDocument();
    expect(screen.getByTestId('enroll-qr-code').tagName).toBe('IMG');

    // Install command is displayed and contains the token
    const cmdEl = screen.getByTestId('enroll-command-display');
    expect(cmdEl.textContent).toContain('test-enroll-token-abc123');
    expect(cmdEl.textContent).toContain('lockdown-installer.exe');
    expect(cmdEl.textContent).toContain('--token');
    expect(cmdEl.textContent).toContain('--server-url');
  });

  it('shows copy command button after token generation', async () => {
    api.post.mockResolvedValue({ data: tokenResponse() });

    renderWithRouter();
    await fireEvent.click(screen.getByRole('button', { name: /Generate Enrollment Token/i }));

    await waitFor(() => {
      expect(screen.getByTestId('copy-command-btn')).toBeInTheDocument();
    });
    expect(screen.getByTestId('copy-command-btn').textContent).toMatch(/Copy Command/i);
  });

  it('shows waiting-for-device status after token generation', async () => {
    api.post.mockResolvedValue({ data: tokenResponse() });

    renderWithRouter();
    await fireEvent.click(screen.getByRole('button', { name: /Generate Enrollment Token/i }));

    await waitFor(() => {
      expect(screen.getByText(/Waiting for device/i)).toBeInTheDocument();
    });
  });

  it('shows countdown timer after token generation', async () => {
    api.post.mockResolvedValue({ data: tokenResponse() });

    renderWithRouter();
    await fireEvent.click(screen.getByRole('button', { name: /Generate Enrollment Token/i }));

    await waitFor(() => {
      // The countdown shows Xm XXs format
      expect(screen.getByText(/\d+m \d+s/)).toBeInTheDocument();
    });
  });

  it('calls POST /enroll/token when generate is clicked', async () => {
    api.post.mockResolvedValue({ data: tokenResponse() });

    renderWithRouter();
    await fireEvent.click(screen.getByRole('button', { name: /Generate Enrollment Token/i }));

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/enroll/token');
    });
  });

  it('shows error toast when token generation fails', async () => {
    api.post.mockRejectedValue({ response: { data: { error: 'Not authorized' } } });

    renderWithRouter();
    await fireEvent.click(screen.getByRole('button', { name: /Generate Enrollment Token/i }));

    // The token display should NOT appear
    await waitFor(() => {
      expect(screen.queryByTestId('enroll-token-display')).not.toBeInTheDocument();
    });
  });

  it('detects a new device and shows success message', async () => {
    api.post.mockResolvedValue({ data: tokenResponse() });
    // First GET: initial snapshot (empty). Second GET: poll finds new device.
    api.get.mockResolvedValueOnce({ data: [] });
    api.get.mockResolvedValueOnce({
      data: [{ id: 'new-1', hostname: 'NEW-DEVICE', status: 'active' }],
    });

    renderWithRouter();
    const generateBtn = screen.getByRole('button', { name: /Generate Enrollment Token/i });
    await fireEvent.click(generateBtn);

    // The poll runs every 5 seconds — wait up to 8 seconds for the new device
    await waitFor(() => {
      expect(screen.getByText(/Device Enrolled/i)).toBeInTheDocument();
    }, { timeout: 8000 });
    expect(screen.getByText(/NEW-DEVICE/)).toBeInTheDocument();
  }, 10000);

  it('QR code src encodes the install command', async () => {
    api.post.mockResolvedValue({ data: tokenResponse() });

    renderWithRouter();
    await fireEvent.click(screen.getByRole('button', { name: /Generate Enrollment Token/i }));

    await waitFor(() => {
      expect(screen.getByTestId('enroll-qr-code')).toBeInTheDocument();
    });
    const qrSrc = screen.getByTestId('enroll-qr-code').getAttribute('src');
    expect(qrSrc).toContain('api.qrserver.com');
    expect(qrSrc).toContain(encodeURIComponent('lockdown-installer.exe'));
  });
});
