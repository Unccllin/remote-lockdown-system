import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import AuditPage from '../src/pages/AuditPage';
import { setupUser, renderWithRouter } from './setup';

// Mock the API client
vi.mock('../src/api/client', () => ({
  default: {
    get: vi.fn(),
  },
}));

import api from '../src/api/client';

const mockLogs = [
  { id: '1', action: 'flag_stolen', hostname: 'DEV-001', admin_username: 'alice', timestamp: '2025-01-01T12:00:00Z', detail: { reason: 'reported stolen' } },
  { id: '2', action: 'recover_device', hostname: 'DEV-002', admin_username: 'bob', timestamp: '2025-01-02T12:00:00Z', detail: null },
  { id: '3', action: 'device_enrolled', hostname: 'DEV-003', admin_username: 'alice', timestamp: '2025-01-03T12:00:00Z', detail: null },
];

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setupUser('operator');
  api.get.mockResolvedValue({ data: mockLogs });
});

describe('AuditPage', () => {
  it('renders page title', async () => {
    renderWithRouter(<AuditPage />);

    await waitFor(() => {
      expect(screen.getByText('Audit Log')).toBeInTheDocument();
    });
  });

  it('calls GET /audit?limit=100 on mount', async () => {
    renderWithRouter(<AuditPage />);

    await waitFor(() => {
      expect(api.get).toHaveBeenCalledWith('/audit?limit=100');
    });
  });

  it('renders audit log entries', async () => {
    renderWithRouter(<AuditPage />);

    await waitFor(() => {
      expect(screen.getByText('flag_stolen')).toBeInTheDocument();
    });
    expect(screen.getByText('recover_device')).toBeInTheDocument();
    expect(screen.getByText('device_enrolled')).toBeInTheDocument();
  });

  it('shows Refresh button', async () => {
    renderWithRouter(<AuditPage />);

    await waitFor(() => {
      expect(screen.getByText('Refresh')).toBeInTheDocument();
    });
  });

  it('shows search input with placeholder', async () => {
    renderWithRouter(<AuditPage />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Search by action, device, or admin…')).toBeInTheDocument();
    });
  });

  it('filters logs by search text', async () => {
    renderWithRouter(<AuditPage />);

    await waitFor(() => {
      expect(screen.getByText('flag_stolen')).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText('Search by action, device, or admin…');
    fireEvent.change(searchInput, { target: { value: 'flag_stolen' } });

    expect(screen.getByText('flag_stolen')).toBeInTheDocument();
    expect(screen.queryByText('recover_device')).not.toBeInTheDocument();
  });

  it('shows empty state when no audit events', async () => {
    api.get.mockResolvedValue({ data: [] });
    renderWithRouter(<AuditPage />);

    await waitFor(() => {
      expect(screen.getByText('No audit events yet.')).toBeInTheDocument();
    });
  });

  it('shows table headers (Timestamp, Action, Device, Admin, Detail)', async () => {
    renderWithRouter(<AuditPage />);

    await waitFor(() => {
      expect(screen.getByText('Timestamp')).toBeInTheDocument();
    });
    expect(screen.getByText('Action')).toBeInTheDocument();
    expect(screen.getByText('Device')).toBeInTheDocument();
    expect(screen.getByText('Admin')).toBeInTheDocument();
    expect(screen.getByText('Detail')).toBeInTheDocument();
  });

  it('shows admin filter dropdown with All admins option', async () => {
    renderWithRouter(<AuditPage />);

    await waitFor(() => {
      expect(screen.getByText('All admins')).toBeInTheDocument();
    });
  });

  it('shows Clear filters button when filters are active', async () => {
    renderWithRouter(<AuditPage />);

    await waitFor(() => {
      expect(screen.getByText('flag_stolen')).toBeInTheDocument();
    });

    // Activate a filter by selecting an admin
    const adminSelect = screen.getByDisplayValue('All admins');
    fireEvent.change(adminSelect, { target: { value: 'alice' } });

    expect(screen.getByText('Clear filters')).toBeInTheDocument();
  });

  it('shows event count footer', async () => {
    renderWithRouter(<AuditPage />);

    await waitFor(() => {
      expect(screen.getByText(/Showing 3 of 3 events/)).toBeInTheDocument();
    });
  });
});
