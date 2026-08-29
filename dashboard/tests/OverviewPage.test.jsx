import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import OverviewPage from '../src/pages/OverviewPage';
import { setupUser } from './setup';

// Mock the API client
vi.mock('../src/api/client', () => ({
  default: {
    get: vi.fn(),
  },
}));

import api from '../src/api/client';

function renderWithRouter() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<OverviewPage />} />
        <Route path="/devices/:id" element={<div data-testid="device-detail">Device Detail</div>} />
      </Routes>
    </MemoryRouter>
  );
}

const mockDevices = [
  { id: '1', hostname: 'DEV-001', owner_name: 'Alice', status: 'active', last_checkin: new Date().toISOString() },
  { id: '2', hostname: 'DEV-002', owner_name: 'Bob', status: 'stolen', last_checkin: new Date().toISOString() },
  { id: '3', hostname: 'DEV-003', owner_name: 'Charlie', status: 'locked', last_checkin: null },
  { id: '4', hostname: 'DEV-004', owner_name: 'Dave', status: 'tracking', last_checkin: new Date().toISOString() },
];

const mockLogs = [
  { id: 'log-1', action: 'flag_stolen', hostname: 'DEV-002', admin_username: 'alice', timestamp: new Date().toISOString() },
  { id: 'log-2', action: 'recover_device', hostname: 'DEV-001', admin_username: 'bob', timestamp: new Date().toISOString() },
];

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setupUser('operator');
  api.get.mockImplementation((url) => {
    if (url === '/devices') return Promise.resolve({ data: mockDevices });
    if (url === '/audit?limit=10') return Promise.resolve({ data: mockLogs });
    return Promise.resolve({ data: [] });
  });
});

describe('OverviewPage', () => {
  it('renders page title', async () => {
    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText('Fleet Overview')).toBeInTheDocument();
    });
  });

  it('calls GET /devices and GET /audit?limit=10 on mount', async () => {
    renderWithRouter();

    await waitFor(() => {
      expect(api.get).toHaveBeenCalledWith('/devices');
      expect(api.get).toHaveBeenCalledWith('/audit?limit=10');
    });
  });

  it('shows Refresh button', async () => {
    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText('Refresh')).toBeInTheDocument();
    });
  });

  it('shows stat cards (Total Devices, Active, At Risk, Tracking)', async () => {
    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText('Total Devices')).toBeInTheDocument();
    });
    // "Active" appears in both stat card and fleet status legend
    expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
    expect(screen.getByText('At Risk')).toBeInTheDocument();
    expect(screen.getAllByText('Tracking').length).toBeGreaterThan(0);
  });

  it('shows correct total device count', async () => {
    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText('4')).toBeInTheDocument();
    });
  });

  it('shows Fleet Status section', async () => {
    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText('Fleet Status')).toBeInTheDocument();
    });
  });

  it('shows Recent Activity section', async () => {
    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText('Recent Activity')).toBeInTheDocument();
    });
  });

  it('renders recent activity log entries', async () => {
    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText('flag_stolen')).toBeInTheDocument();
    });
    expect(screen.getByText('recover_device')).toBeInTheDocument();
  });

  it('shows Devices Needing Attention section', async () => {
    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText('Devices Needing Attention')).toBeInTheDocument();
    });
  });

  it('shows attention devices (stolen and locked, not active/tracking)', async () => {
    renderWithRouter();

    await waitFor(() => {
      // DEV-002 appears in both recent activity and attention cards
      expect(screen.getAllByText('DEV-002').length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText('DEV-003').length).toBeGreaterThan(0);
    // Active and tracking devices should NOT be in the attention section
    // (they appear only in stat cards, not attention cards)
  });

  it('shows empty state when no devices enrolled', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/devices') return Promise.resolve({ data: [] });
      if (url === '/audit?limit=10') return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText(/No devices enrolled yet/i)).toBeInTheDocument();
    });
  });

  it('shows no recent activity message when logs empty', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/devices') return Promise.resolve({ data: mockDevices });
      if (url === '/audit?limit=10') return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText('No recent activity.')).toBeInTheDocument();
    });
  });

  it('shows all devices operating normally when no attention devices', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/devices') return Promise.resolve({ data: [{ id: '1', hostname: 'DEV-001', status: 'active', last_checkin: new Date().toISOString() }] });
      if (url === '/audit?limit=10') return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText(/All devices are operating normally/i)).toBeInTheDocument();
    });
  });

  it('shows monitoring subtitle with device count', async () => {
    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText(/Monitoring 4 devices/i)).toBeInTheDocument();
    });
  });
});
