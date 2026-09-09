/**
 * D-206: PBL device detail page — agent mapping UI tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import PblDeviceDetailPage from '../src/pages/PblDeviceDetailPage';
import { setupUser } from './setup';

// Mock the PBL API client
vi.mock('../src/api/pblClient', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  },
  pblDevices: {
    getAgentMapping: vi.fn(),
    linkAgentMapping: vi.fn(),
    unlinkAgentMapping: vi.fn(),
  },
}));

import pblApi, { pblDevices } from '../src/api/pblClient';

function renderWithRouter(deviceId = 'd2060001'.repeat(8)) {
  return render(
    <MemoryRouter initialEntries={[`/pbl-devices/${deviceId}`]}>
      <Routes>
        <Route path="pbl-devices/:id" element={<PblDeviceDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: device loads successfully
  pblApi.get.mockResolvedValue({
    data: {
      device: {
        device_id: 'd2060001'.repeat(8),
        status: 'active',
        enrolled_at: '2026-01-01T00:00:00Z',
        hostname: 'test-host',
      },
    },
  });
  // Default: no mapping
  pblDevices.getAgentMapping.mockResolvedValue({ data: { mapped: false } });
});

describe('D-206: PblDeviceDetailPage agent mapping UI', () => {
  it('renders the Agent Device Mapping section for operators', async () => {
    setupUser('super-admin');
    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText('Agent Device Mapping')).toBeInTheDocument();
    });
  });

  it('shows link input when no mapping exists', async () => {
    setupUser('super-admin');
    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByPlaceholderText('agent-device-uuid...')).toBeInTheDocument();
    });
  });

  it('shows linked agent device when mapping exists', async () => {
    setupUser('super-admin');
    pblDevices.getAgentMapping.mockResolvedValue({
      data: { mapped: true, agent_device_id: 'agent-uuid-1234' },
    });
    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText('agent-uuid-1234')).toBeInTheDocument();
    });
    expect(screen.getByText('Unlink')).toBeInTheDocument();
  });

  it('calls linkAgentMapping when Link button is clicked', async () => {
    setupUser('super-admin');
    pblDevices.linkAgentMapping.mockResolvedValue({ data: { mapped: true } });
    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByPlaceholderText('agent-device-uuid...')).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText('agent-device-uuid...');
    fireEvent.change(input, { target: { value: 'new-agent-uuid' } });

    const linkBtn = screen.getByText('Link');
    fireEvent.click(linkBtn);

    await waitFor(() => {
      expect(pblDevices.linkAgentMapping).toHaveBeenCalledWith(
        'd2060001'.repeat(8),
        'new-agent-uuid',
      );
    });
  });

  it('calls unlinkAgentMapping when Unlink button is clicked', async () => {
    setupUser('super-admin');
    pblDevices.getAgentMapping.mockResolvedValue({
      data: { mapped: true, agent_device_id: 'agent-uuid-1234' },
    });
    pblDevices.unlinkAgentMapping.mockResolvedValue({ data: { unmapped: true } });
    // Mock confirm dialog
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText('Unlink')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Unlink'));

    await waitFor(() => {
      expect(pblDevices.unlinkAgentMapping).toHaveBeenCalledWith('d2060001'.repeat(8));
    });
  });

  it('does not render mapping section for viewers', async () => {
    setupUser('viewer');
    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText('Device Information')).toBeInTheDocument();
    });
    expect(screen.queryByText('Agent Device Mapping')).not.toBeInTheDocument();
  });
});
