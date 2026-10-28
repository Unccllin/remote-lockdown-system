import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import HealthPage from '../src/pages/HealthPage';
import { setupUser, renderWithRouter } from './setup';

// Mock the API client
vi.mock('../src/api/client', () => ({
  default: {
    get: vi.fn(),
  },
}));

// Mock useServerlessMode
vi.mock('../src/hooks/useServerlessMode', () => ({
  useServerlessMode: vi.fn(() => ({ serverless: false })),
}));

import api from '../src/api/client';
import { useServerlessMode } from '../src/hooks/useServerlessMode';

const mockHealthData = {
  status: 'ok',
  server: {
    uptimeSeconds: 90061,
    memory: { heapUsedMb: 50, heapTotalMb: 100, rssMb: 120 },
  },
  db: { connected: true, latencyMs: 5 },
  fleet: { total: 10, active: 6, stale: 2, missing: 1, dead: 1, never: 0 },
  queueDepth: 3,
  recentAlerts: [
    { id: 'a1', action: 'flag_stolen', timestamp: new Date().toISOString(), detail: 'Device reported stolen' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setupUser('operator');
  useServerlessMode.mockReturnValue({ serverless: false });
  api.get.mockResolvedValue({ data: mockHealthData });
});

describe('HealthPage', () => {
  it('renders page title', async () => {
    renderWithRouter(<HealthPage />);

    await waitFor(() => {
      expect(screen.getByText('System Health')).toBeInTheDocument();
    });
  });

  it('calls GET /health/detailed on mount', async () => {
    renderWithRouter(<HealthPage />);

    await waitFor(() => {
      expect(api.get).toHaveBeenCalledWith('/health/detailed');
    });
  });

  it('shows Refresh button', async () => {
    renderWithRouter(<HealthPage />);

    await waitFor(() => {
      expect(screen.getByText('Refresh')).toBeInTheDocument();
    });
  });

  it('shows Server Status card with Healthy label', async () => {
    renderWithRouter(<HealthPage />);

    await waitFor(() => {
      expect(screen.getByText('Server Status')).toBeInTheDocument();
    });
    // 'Healthy' is derived from the fetched payload (it reads 'Down' while
    // `data` is still null), so it must be awaited separately. Waiting only
    // for the static card title raced the response and failed on CI, where
    // the promise resolved after the title had already painted.
    expect(await screen.findByText('Healthy')).toBeInTheDocument();
  });

  it('shows Fleet Status card with device count', async () => {
    renderWithRouter(<HealthPage />);

    await waitFor(() => {
      expect(screen.getByText('Fleet Status')).toBeInTheDocument();
    });
    // The count renders as '0 devices' until the payload lands — assert the
    // loaded value, not the placeholder.
    expect(await screen.findByText('10 devices')).toBeInTheDocument();
  });

  it('shows Command Queue card with pending count', async () => {
    renderWithRouter(<HealthPage />);

    await waitFor(() => {
      expect(screen.getByText('Command Queue')).toBeInTheDocument();
    });
    expect(screen.getByText('Pending commands')).toBeInTheDocument();
  });

  it('shows fleet status labels (Active, Stale, Missing, Dead, Never)', async () => {
    renderWithRouter(<HealthPage />);

    await waitFor(() => {
      expect(screen.getByText('Active')).toBeInTheDocument();
    });
    expect(screen.getByText('Stale')).toBeInTheDocument();
    expect(screen.getByText('Missing')).toBeInTheDocument();
    expect(screen.getByText('Dead')).toBeInTheDocument();
    expect(screen.getByText('Never')).toBeInTheDocument();
  });

  it('shows Recent Alerts section', async () => {
    renderWithRouter(<HealthPage />);

    await waitFor(() => {
      expect(screen.getByText('Recent Alerts')).toBeInTheDocument();
    });
    expect(await screen.findByText('flag_stolen')).toBeInTheDocument();
  });

  it('shows no alerts message when recentAlerts is empty', async () => {
    api.get.mockResolvedValue({ data: { ...mockHealthData, recentAlerts: [] } });
    renderWithRouter(<HealthPage />);

    await waitFor(() => {
      expect(screen.getByText('No recent alerts.')).toBeInTheDocument();
    });
  });

  it('shows queue backlog message when queueDepth > 0', async () => {
    renderWithRouter(<HealthPage />);

    await waitFor(() => {
      expect(screen.getByText('Backlog detected')).toBeInTheDocument();
    });
  });

  it('shows queue clear message when queueDepth is 0', async () => {
    api.get.mockResolvedValue({ data: { ...mockHealthData, queueDepth: 0 } });
    renderWithRouter(<HealthPage />);

    await waitFor(() => {
      expect(screen.getByText('Queue clear')).toBeInTheDocument();
    });
  });

  it('renders serverless mode view when serverless', async () => {
    useServerlessMode.mockReturnValue({ serverless: true });
    api.get.mockResolvedValue({
      data: { status: 'ok', serverless: true, devices: 5, pending_commands: 2, timestamp: new Date().toISOString() },
    });
    renderWithRouter(<HealthPage />);

    await waitFor(() => {
      expect(screen.getByText(/Connected to Cloudflare Worker/i)).toBeInTheDocument();
    });
    expect(screen.getByText('Enrolled devices')).toBeInTheDocument();
    expect(screen.getByText('Pending commands')).toBeInTheDocument();
  });

  it('shows uptime formatted (days, hours, minutes)', async () => {
    renderWithRouter(<HealthPage />);

    await waitFor(() => {
      // 90061 seconds = 1d 1h 1m 1s
      expect(screen.getByText('1d 1h 1m')).toBeInTheDocument();
    });
  });

  it('shows DB latency when connected', async () => {
    renderWithRouter(<HealthPage />);

    await waitFor(() => {
      expect(screen.getByText('5ms')).toBeInTheDocument();
    });
  });
});
