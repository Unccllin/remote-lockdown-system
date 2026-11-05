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

function setupCommandResponse() {
  return {
    server_url: 'https://lockdown.example.com',
    mode: 'gui',
    one_liner:
      'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm ' +
      'https://lockdown.example.com/api/enroll/setup.ps1' +
      ' | iex"',
    ps1_url: 'https://lockdown.example.com/api/enroll/setup.ps1',
    cmd_url: 'https://lockdown.example.com/api/enroll/setup.cmd',
    command: "$u = 'https://lockdown.example.com'\nSet-Clipboard $u\nStart-Process $e -Verb RunAs",
    notes: ['The wizard opens elevated.'],
  };
}

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
    // URL-aware, not a queue: the page also fetches /enroll/setup-command on mount,
    // so positional `mockResolvedValueOnce` values would be consumed out of order.
    let devicePolls = 0;
    api.get.mockImplementation((url) => {
      if (url === '/enroll/setup-command') {
        return Promise.resolve({ data: setupCommandResponse() });
      }
      devicePolls += 1;
      return Promise.resolve({
        data:
          devicePolls === 1
            ? []
            : [{ id: 'new-1', hostname: 'NEW-DEVICE', status: 'active' }],
      });
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

  it('shows the server-composed setup command instead of composing one locally', async () => {
    // Both past failures came from the browser composing the URL: a host only the
    // server could resolve, and a tailnet name mistyped out of a chat window.
    api.post.mockResolvedValue({ data: tokenResponse() });
    api.get.mockImplementation((url) => {
      if (url === '/enroll/setup-command') return Promise.resolve({ data: setupCommandResponse() });
      return Promise.resolve({ data: [] });
    });

    renderWithRouter();
    await fireEvent.click(screen.getByRole('button', { name: /Generate Enrollment Token/i }));

    await waitFor(() => {
      expect(screen.getByTestId('enroll-command-display')).toBeInTheDocument();
    });
    const shown = screen.getByTestId('enroll-command-display').textContent;
    expect(shown).toContain("https://lockdown.example.com");
    expect(shown).toContain('Set-Clipboard');
    // The server's note is shown too, so the operator knows what to paste where.
    expect(screen.getByText(/The wizard opens elevated/)).toBeInTheDocument();
  });

  it('keeps the QR code on the short command so it stays scannable', async () => {
    api.post.mockResolvedValue({ data: tokenResponse() });
    api.get.mockImplementation((url) => {
      if (url === '/enroll/setup-command') return Promise.resolve({ data: setupCommandResponse() });
      return Promise.resolve({ data: [] });
    });

    renderWithRouter();
    await fireEvent.click(screen.getByRole('button', { name: /Generate Enrollment Token/i }));

    await waitFor(() => {
      expect(screen.getByTestId('enroll-qr-code')).toBeInTheDocument();
    });
    const qrSrc = screen.getByTestId('enroll-qr-code').getAttribute('src');
    // Short form: the token + server URL, not the whole script.
    expect(qrSrc).toContain(encodeURIComponent('lockdown-installer.exe'));
    expect(qrSrc).not.toContain(encodeURIComponent('Set-Clipboard'));
  });

  it('shows the one-liner as the primary action, with the .cmd file beside it', async () => {
    // MeshCentral's ergonomics: one line to paste, or a file to double-click.
    api.post.mockResolvedValue({ data: tokenResponse() });
    api.get.mockImplementation((url) => {
      if (url === '/enroll/setup-command') return Promise.resolve({ data: setupCommandResponse() });
      return Promise.resolve({ data: [] });
    });

    renderWithRouter();
    await fireEvent.click(screen.getByRole('button', { name: /Generate Enrollment Token/i }));

    await waitFor(() => {
      expect(screen.getByTestId('enroll-oneliner-display')).toBeInTheDocument();
    });

    const oneLiner = screen.getByTestId('enroll-oneliner-display').textContent;
    expect(oneLiner).toContain('| iex');
    expect(oneLiner).toContain('/api/enroll/setup.ps1');
    // No token, no URL composed in the browser.
    expect(oneLiner).not.toMatch(/--token/);

    expect(screen.getByTestId('download-setup-cmd')).toHaveAttribute(
      'href',
      'https://lockdown.example.com/api/enroll/setup.cmd'
    );
  });

  it('copies the one-liner, not the long script', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    api.post.mockResolvedValue({ data: tokenResponse() });
    api.get.mockImplementation((url) => {
      if (url === '/enroll/setup-command') return Promise.resolve({ data: setupCommandResponse() });
      return Promise.resolve({ data: [] });
    });

    renderWithRouter();
    await fireEvent.click(screen.getByRole('button', { name: /Generate Enrollment Token/i }));
    await waitFor(() => expect(screen.getByTestId('copy-command-btn')).toBeInTheDocument());
    await fireEvent.click(screen.getByTestId('copy-command-btn'));

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0][0]).toContain('| iex');
    expect(writeText.mock.calls[0][0]).not.toContain('Set-Clipboard');
  });
});
