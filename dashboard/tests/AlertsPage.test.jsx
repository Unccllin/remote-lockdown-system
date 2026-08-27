import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import AlertsPage from '../src/pages/AlertsPage';
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
    <MemoryRouter initialEntries={['/alerts']}>
      <Routes>
        <Route path="/alerts" element={<AlertsPage />} />
        <Route path="/devices/:id" element={<div>Device Detail</div>} />
      </Routes>
    </MemoryRouter>
  );
}

const staleDevice = {
  id: 'dev-1',
  hostname: 'STALE-001',
  owner_name: 'Alice',
  status: 'active',
  last_checkin: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(), // 30h ago
  enrolled_at: '2025-01-01T00:00:00Z',
};

const freshDevice = {
  id: 'dev-2',
  hostname: 'FRESH-001',
  owner_name: 'Bob',
  status: 'active',
  last_checkin: new Date().toISOString(),
  enrolled_at: '2025-01-01T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setupUser('operator');
});

afterEach(() => {
  localStorage.clear();
});

describe('AlertsPage', () => {
  it('renders page title', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/devices') return Promise.resolve({ data: [] });
      if (url.startsWith('/audit')) return Promise.resolve({ data: [] });
      if (url.includes('/locations')) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });

    renderWithRouter();
    expect(screen.getByText('Alerts')).toBeInTheDocument();
  });

  it('shows missed check-in alert for device offline >24h', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/devices') return Promise.resolve({ data: [staleDevice, freshDevice] });
      if (url.startsWith('/audit')) return Promise.resolve({ data: [] });
      if (url.includes('/locations')) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });

    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText('Missed Check-in')).toBeInTheDocument();
    });
    expect(screen.getByText('STALE-001')).toBeInTheDocument();
  });

  it('does not show missed check-in for fresh devices', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/devices') return Promise.resolve({ data: [freshDevice] });
      if (url.startsWith('/audit')) return Promise.resolve({ data: [] });
      if (url.includes('/locations')) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });

    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText(/No alerts detected|All alerts have been dismissed/)).toBeInTheDocument();
    });
  });

  it('shows empty state when no alerts', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/devices') return Promise.resolve({ data: [] });
      if (url.startsWith('/audit')) return Promise.resolve({ data: [] });
      if (url.includes('/locations')) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });

    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText('No alerts detected.')).toBeInTheDocument();
    });
  });

  it('dismisses alert on X button click', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/devices') return Promise.resolve({ data: [staleDevice] });
      if (url.startsWith('/audit')) return Promise.resolve({ data: [] });
      if (url.includes('/locations')) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });

    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText('STALE-001')).toBeInTheDocument();
    });

    const dismissButton = screen.getByTitle('Dismiss alert');
    fireEvent.click(dismissButton);

    await waitFor(() => {
      expect(screen.getByText('All alerts have been dismissed.')).toBeInTheDocument();
    });
  });

  it('shows severity filter buttons with counts', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/devices') return Promise.resolve({ data: [staleDevice] });
      if (url.startsWith('/audit')) return Promise.resolve({ data: [] });
      if (url.includes('/locations')) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });

    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText(/All \(/)).toBeInTheDocument();
      expect(screen.getByText(/Warning \(/)).toBeInTheDocument();
    });
  });
});
