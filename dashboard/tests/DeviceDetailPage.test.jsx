import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import DeviceDetailPage from '../src/pages/DeviceDetailPage';

// Mock the API client
vi.mock('../src/api/client', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

import api from '../src/api/client';

function renderWithRouter(deviceId = '1') {
  return render(
    <MemoryRouter initialEntries={[`/devices/${deviceId}`]}>
      <Routes>
        <Route path="/devices/:id" element={<DeviceDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
}

const baseDevice = {
  id: '1',
  hostname: 'DEV-001',
  owner_name: 'Alice',
  status: 'active',
  last_checkin: '2025-01-01T00:00:00Z',
  enrolled_at: '2025-01-01T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('DeviceDetailPage', () => {
  it('shows Flag as Stolen button when status is active', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/devices/1')) {
        return Promise.resolve({ data: baseDevice });
      }
      if (url.startsWith('/audit')) {
        return Promise.resolve({ data: [] });
      }
      return Promise.resolve({ data: [] });
    });

    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText('Flag as Stolen')).toBeInTheDocument();
    });
  });

  it('shows Recover button when status is stolen', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/devices/1')) {
        return Promise.resolve({ data: { ...baseDevice, status: 'stolen' } });
      }
      return Promise.resolve({ data: [] });
    });

    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText('Recover Device')).toBeInTheDocument();
    });
    expect(screen.queryByText('Flag as Stolen')).not.toBeInTheDocument();
  });

  it('shows Recover button when status is locked', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/devices/1')) {
        return Promise.resolve({ data: { ...baseDevice, status: 'locked' } });
      }
      return Promise.resolve({ data: [] });
    });

    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText('Recover Device')).toBeInTheDocument();
    });
  });

  it('shows recovery in-progress indicator when status is recovering', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/devices/1')) {
        return Promise.resolve({ data: { ...baseDevice, status: 'recovering' } });
      }
      return Promise.resolve({ data: [] });
    });

    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText(/Recovery in progress/i)).toBeInTheDocument();
    });

    // Should NOT show action buttons
    expect(screen.queryByText('Flag as Stolen')).not.toBeInTheDocument();
    expect(screen.queryByText('Recover Device')).not.toBeInTheDocument();
  });

  it('does not show Flag as Stolen when status is recovering', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/devices/1')) {
        return Promise.resolve({ data: { ...baseDevice, status: 'recovering' } });
      }
      return Promise.resolve({ data: [] });
    });

    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText(/Recovery in progress/i)).toBeInTheDocument();
    });

    expect(screen.queryByText('Flag as Stolen')).not.toBeInTheDocument();
  });

  it('shows Start Tracking button when status is active', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/devices/1')) {
        return Promise.resolve({ data: baseDevice });
      }
      return Promise.resolve({ data: [] });
    });

    renderWithRouter();

    // FA7: Use getByRole to find the button specifically (text also appears in info span)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Start Tracking/i })).toBeInTheDocument();
    });
  });

  it('shows Stop Tracking button when status is tracking', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/devices/1')) {
        return Promise.resolve({ data: { ...baseDevice, status: 'tracking' } });
      }
      return Promise.resolve({ data: [] });
    });

    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Stop Tracking/i })).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /Start Tracking/i })).not.toBeInTheDocument();
  });

  it('shows latest location card when location data exists', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/devices/1') && !url.includes('location')) {
        return Promise.resolve({ data: baseDevice });
      }
      if (url.includes('/locations')) {
        return Promise.resolve({
          data: [{
            id: 'loc-1',
            latitude: 37.7749,
            longitude: -122.4194,
            source: 'wifi',
            accuracy_meters: 25,
            city: 'San Francisco',
            region: 'CA',
            country: 'US',
            reported_at: '2025-01-01T00:00:00Z',
          }],
        });
      }
      return Promise.resolve({ data: [] });
    });

    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText('Latest Location')).toBeInTheDocument();
    }, { timeout: 3000 });
  });
});

// ---------------------------------------------------------------------------
// FA7: userEvent flow tests — test clicks through ConfirmModal-gated paths
// ---------------------------------------------------------------------------

describe('DeviceDetailPage — userEvent flows', () => {
  it('FA7: flag as stolen flow — click button, type hostname, confirm', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/devices/1') && !url.includes('location')) {
        return Promise.resolve({ data: baseDevice });
      }
      return Promise.resolve({ data: [] });
    });
    api.post.mockResolvedValue({ data: { device: { ...baseDevice, status: 'stolen' } } });

    renderWithRouter();

    // Wait for the action button and click to open modal
    const actionBtn = await screen.findByRole('button', { name: /Flag as Stolen/i });
    fireEvent.click(actionBtn);

    // Wait for modal to appear, then scope queries to the modal overlay
    const modalTitle = await screen.findByRole('heading', { name: /Flag Device as Stolen/i });
    const modalContainer = modalTitle.closest('.fixed.inset-0');

    // Type hostname in the modal input
    const input = within(modalContainer).getByPlaceholderText('DEV-001');
    fireEvent.change(input, { target: { value: 'DEV-001' } });

    // Click the confirm button inside the modal
    await waitFor(() => {
      const confirmBtn = within(modalContainer).getByRole('button', { name: /Flag as Stolen/i });
      expect(confirmBtn).not.toBeDisabled();
    });
    const confirmBtn = within(modalContainer).getByRole('button', { name: /Flag as Stolen/i });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/devices/1/flag-stolen', expect.any(Object));
    });
  });

  it('FA7: recover device flow — click button, type hostname, confirm', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/devices/1') && !url.includes('location')) {
        return Promise.resolve({ data: { ...baseDevice, status: 'stolen' } });
      }
      return Promise.resolve({ data: [] });
    });
    api.post.mockResolvedValue({ data: { device: { ...baseDevice, status: 'recovering' } } });

    renderWithRouter();

    const actionBtn = await screen.findByRole('button', { name: /Recover Device/i });
    fireEvent.click(actionBtn);

    // Use heading role to find the modal title (not the action button)
    const modalTitle = await screen.findByRole('heading', { name: /Recover Device/i });
    const modalContainer = modalTitle.closest('.fixed.inset-0');

    const input = within(modalContainer).getByPlaceholderText('DEV-001');
    fireEvent.change(input, { target: { value: 'DEV-001' } });

    await waitFor(() => {
      const confirmBtn = within(modalContainer).getByRole('button', { name: /Recover Device/i });
      expect(confirmBtn).not.toBeDisabled();
    });
    const confirmBtn = within(modalContainer).getByRole('button', { name: /Recover Device/i });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/devices/1/recover', expect.anything());
    });
  });

  it('FA7: start tracking flow — click button, confirm (active device)', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/devices/1') && !url.includes('location')) {
        return Promise.resolve({ data: baseDevice }); // status: active
      }
      return Promise.resolve({ data: [] });
    });
    api.post.mockResolvedValue({ data: { command: { id: 'cmd-1', command_type: 'track' } } });

    renderWithRouter();

    // Use getAllByRole to find the button (not the info span)
    await waitFor(() => {
      const btns = screen.getAllByRole('button', { name: /Start Tracking/i });
      expect(btns.length).toBeGreaterThanOrEqual(1);
    });
    const actionBtn = screen.getAllByRole('button', { name: /Start Tracking/i })[0];
    fireEvent.click(actionBtn);

    // Track modal — no confirmValue, so confirm is enabled immediately
    const modalTitle = await screen.findByRole('heading', { name: /Start Covert Tracking/i });
    const modalContainer = modalTitle.closest('.fixed.inset-0');

    const confirmBtn = within(modalContainer).getByRole('button', { name: /Start Tracking/i });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/devices/1/track');
    });
  });

  it('FA7: stop tracking flow — click button, confirm', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/devices/1') && !url.includes('location')) {
        return Promise.resolve({ data: { ...baseDevice, status: 'tracking' } });
      }
      return Promise.resolve({ data: [] });
    });
    api.post.mockResolvedValue({ data: { command: { id: 'cmd-1', command_type: 'stop_track' } } });

    renderWithRouter();

    const actionBtn = await screen.findByRole('button', { name: /Stop Tracking/i });
    fireEvent.click(actionBtn);

    const modalTitle = await screen.findByRole('heading', { name: /Stop Tracking/i });
    const modalContainer = modalTitle.closest('.fixed.inset-0');

    const confirmBtn = within(modalContainer).getByRole('button', { name: /Stop Tracking/i });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/devices/1/stop-track');
    });
  });
});
