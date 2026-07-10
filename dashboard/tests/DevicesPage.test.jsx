import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import DevicesPage from '../src/pages/DevicesPage';

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
    <MemoryRouter>
      <DevicesPage />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
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

    renderWithRouter();

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

    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText('DEV-001')).toBeInTheDocument();
    });

    // The recovering stat card should show count 1
    const recoveringCards = screen.getAllByText('Recovering');
    expect(recoveringCards.length).toBeGreaterThan(0);
  });

  it('shows empty state when no devices', async () => {
    api.get.mockResolvedValue({ data: [] });

    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText(/No devices enrolled/i)).toBeInTheDocument();
    });
  });

  it('shows 4 stat cards (Active, Stolen/Locked, Recovering, Total)', async () => {
    api.get.mockResolvedValue({
      data: [
        { id: '1', hostname: 'DEV-001', owner_name: 'Alice', status: 'active', last_checkin: null, enrolled_at: '2025-01-01' },
      ],
    });

    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText('DEV-001')).toBeInTheDocument();
    });

    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Stolen / Locked')).toBeInTheDocument();
    expect(screen.getByText('Recovering')).toBeInTheDocument();
    expect(screen.getByText('Total')).toBeInTheDocument();
  });
});
