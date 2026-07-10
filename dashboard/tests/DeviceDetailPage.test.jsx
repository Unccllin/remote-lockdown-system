import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

    await waitFor(() => {
      expect(screen.getByText('Start Tracking')).toBeInTheDocument();
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
      expect(screen.getByText('Stop Tracking')).toBeInTheDocument();
    });
    expect(screen.queryByText('Start Tracking')).not.toBeInTheDocument();
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
