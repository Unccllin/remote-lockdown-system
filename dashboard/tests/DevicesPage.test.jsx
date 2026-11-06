import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import DevicesPage from '../src/pages/DevicesPage';
import { setupUser, renderWithRouter } from './setup';

// Mock the API client
vi.mock('../src/api/client', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

import api from '../src/api/client';

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setupUser('operator');
});

describe('DevicesPage', () => {
  it('renders device list with statuses', async () => {
    api.get.mockResolvedValue({
      data: [
        { id: '1', hostname: 'DEV-001', owner_name: 'Alice', status: 'active', last_checkin: null, enrolled_at: '2025-01-01' },
        { id: '2', hostname: 'DEV-002', owner_name: 'Bob', status: 'stolen', last_checkin: null, enrolled_at: '2025-01-02' },
        { id: '3', hostname: 'DEV-003', owner_name: 'Charlie', status: 'locked', last_checkin: null, enrolled_at: '2025-01-03' },
        { id: '4', hostname: 'DEV-004', owner_name: 'Dave', status: 'recovering', last_checkin: null, enrolled_at: '2025-01-04' },
      ],
    });

    renderWithRouter(<DevicesPage />);

    await waitFor(() => {
      expect(screen.getByText('DEV-001')).toBeInTheDocument();
    });

    expect(screen.getByText('DEV-002')).toBeInTheDocument();
    expect(screen.getByText('DEV-003')).toBeInTheDocument();
    expect(screen.getByText('DEV-004')).toBeInTheDocument();
  });

  it('shows recovering stat card', async () => {
    api.get.mockResolvedValue({
      data: [
        { id: '1', hostname: 'DEV-001', owner_name: 'Alice', status: 'active', last_checkin: null, enrolled_at: '2025-01-01' },
        { id: '2', hostname: 'DEV-002', owner_name: 'Bob', status: 'recovering', last_checkin: null, enrolled_at: '2025-01-02' },
      ],
    });

    renderWithRouter(<DevicesPage />);

    await waitFor(() => {
      expect(screen.getByText('DEV-001')).toBeInTheDocument();
    });

    // The recovering stat card should show count 1
    const recoveringCards = screen.getAllByText('Recovering');
    expect(recoveringCards.length).toBeGreaterThan(0);
  });

  it('shows empty state when no devices', async () => {
    api.get.mockResolvedValue({ data: [] });

    renderWithRouter(<DevicesPage />);

    await waitFor(() => {
      expect(screen.getByText(/No devices enrolled/i)).toBeInTheDocument();
    });
  });

  it('shows 5 stat cards (Active, Stolen/Locked, Tracking, Recovering, Total)', async () => {
    api.get.mockResolvedValue({
      data: [
        { id: '1', hostname: 'DEV-001', owner_name: 'Alice', status: 'active', last_checkin: null, enrolled_at: '2025-01-01' },
      ],
    });

    renderWithRouter(<DevicesPage />);

    await waitFor(() => {
      expect(screen.getByText('DEV-001')).toBeInTheDocument();
    });

    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Stolen / Locked')).toBeInTheDocument();
    expect(screen.getByText('Tracking')).toBeInTheDocument();
    expect(screen.getByText('Recovering')).toBeInTheDocument();
    expect(screen.getByText('Total')).toBeInTheDocument();
  });

  // B-006 / S193: a device that would accept an unauthenticated update must be
  // visible in the list, not only on its detail page.
  it('marks devices whose updates are unverified (sha256-only)', async () => {
    api.get.mockResolvedValue({
      data: [
        { id: '1', hostname: 'DEV-PLAIN', owner_name: 'Alice', status: 'active', last_checkin: null, enrolled_at: '2025-01-01', update_verification: 'sha256-only' },
        { id: '2', hostname: 'DEV-PINNED', owner_name: 'Bob', status: 'active', last_checkin: null, enrolled_at: '2025-01-02', update_verification: 'signature' },
        { id: '3', hostname: 'DEV-SILENT', owner_name: 'Charlie', status: 'active', last_checkin: null, enrolled_at: '2025-01-03' },
      ],
    });

    renderWithRouter(<DevicesPage />);

    await waitFor(() => {
      expect(screen.getByText('DEV-PLAIN')).toBeInTheDocument();
    });

    // Exactly one badge — the pinned and never-reported rows carry none.
    expect(screen.getAllByText('updates unverified')).toHaveLength(1);
    expect(screen.queryByText('updates blocked')).not.toBeInTheDocument();
  });

  it('distinguishes a device that refuses updates from one that accepts them unverified', async () => {
    // 'key-unreadable' means a pin is configured but cannot be read, so the agent
    // refuses every update. Reporting that as "unverified" would be the opposite
    // of what happens.
    api.get.mockResolvedValue({
      data: [
        { id: '1', hostname: 'DEV-BLOCKED', owner_name: 'Alice', status: 'active', last_checkin: null, enrolled_at: '2025-01-01', update_verification: 'key-unreadable' },
      ],
    });

    renderWithRouter(<DevicesPage />);

    await waitFor(() => {
      expect(screen.getByText('DEV-BLOCKED')).toBeInTheDocument();
    });

    expect(screen.getByText('updates blocked')).toBeInTheDocument();
    expect(screen.queryByText('updates unverified')).not.toBeInTheDocument();
  });
});

describe('DevicesPage — agent version (D-222)', () => {
  const withVersions = [
    { id: '1', hostname: 'DEV-001', owner_name: 'Alice', status: 'active', last_checkin: null, enrolled_at: '2025-01-01', agent_version: '1.4.2' },
    { id: '2', hostname: 'DEV-002', owner_name: 'Bob', status: 'active', last_checkin: null, enrolled_at: '2025-01-02', agent_version: null },
  ];

  it('shows the reported version', async () => {
    api.get.mockResolvedValue({ data: withVersions });
    renderWithRouter(<DevicesPage />);

    await waitFor(() => expect(screen.getByText('DEV-001')).toBeInTheDocument());
    expect(screen.getByText('1.4.2')).toBeInTheDocument();
  });

  it('shows "unknown" for a device that never reported one, not a blank cell', async () => {
    // A blank reads as "fine"; this is the one state a rollout must notice.
    api.get.mockResolvedValue({ data: withVersions });
    renderWithRouter(<DevicesPage />);

    await waitFor(() => expect(screen.getByText('DEV-002')).toBeInTheDocument());
    expect(screen.getByText('unknown')).toBeInTheDocument();
  });

  it('sorts by the Agent column', async () => {
    api.get.mockResolvedValue({ data: withVersions });
    renderWithRouter(<DevicesPage />);

    await waitFor(() => expect(screen.getByText('DEV-001')).toBeInTheDocument());
    const header = screen.getByText('Agent').closest('th');
    fireEvent.click(header);

    // Sorting must change the aria-sort state rather than throw on a missing field.
    await waitFor(() => expect(header).toHaveAttribute('aria-sort'));
  });

  it('searching by version finds the devices on it', async () => {
    api.get.mockResolvedValue({ data: withVersions });
    renderWithRouter(<DevicesPage />);

    await waitFor(() => expect(screen.getByText('DEV-001')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText(/Search by hostname/i), { target: { value: '1.4.2' } });

    await waitFor(() => {
      expect(screen.getByText('DEV-001')).toBeInTheDocument();
      expect(screen.queryByText('DEV-002')).not.toBeInTheDocument();
    });
  });
});

describe('DevicesPage — stale version report (D-258)', () => {
  it('badges a device that checks in but stopped reporting its version', async () => {
    api.get.mockResolvedValue({
      data: [
        { id: '1', hostname: 'DEV-CUR', owner_name: 'A', status: 'active', last_checkin: '2026-11-05T12:00:00Z',
          enrolled_at: '2025-01-01', agent_version: '1.4.2', agent_version_stale: false },
        { id: '2', hostname: 'DEV-STALE', owner_name: 'B', status: 'active', last_checkin: '2026-11-05T12:00:00Z',
          enrolled_at: '2025-01-02', agent_version: '1.4.2', agent_version_stale: true },
      ],
    });
    renderWithRouter(<DevicesPage />);

    await waitFor(() => expect(screen.getByText('DEV-STALE')).toBeInTheDocument());
    // Exactly one badge: the current device must not be marked stale.
    expect(screen.getAllByText('stale')).toHaveLength(1);
  });

  it('does not badge a device with a current report', async () => {
    api.get.mockResolvedValue({
      data: [
        { id: '1', hostname: 'DEV-CUR', owner_name: 'A', status: 'active', last_checkin: '2026-11-05T12:00:00Z',
          enrolled_at: '2025-01-01', agent_version: '1.4.2', agent_version_stale: false },
      ],
    });
    renderWithRouter(<DevicesPage />);

    await waitFor(() => expect(screen.getByText('DEV-CUR')).toBeInTheDocument());
    expect(screen.queryByText('stale')).not.toBeInTheDocument();
  });
});
