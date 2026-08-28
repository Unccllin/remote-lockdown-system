import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import DeviceDetailPage from '../src/pages/DeviceDetailPage';
import { setupUser } from './setup';

// Mock react-leaflet — Leaflet's MapContainer doesn't work in jsdom
vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }) => <div data-testid="mock-map">{children}</div>,
  TileLayer: () => null,
  Marker: ({ children }) => <div data-testid="mock-marker">{children}</div>,
  Popup: ({ children }) => <div>{children}</div>,
  Circle: () => null,
  Polyline: () => null,
  useMap: () => ({ setView: vi.fn(), fitBounds: vi.fn() }),
}));

vi.mock('leaflet', () => ({
  default: {
    divIcon: vi.fn(() => ({})),
    latLngBounds: vi.fn(() => ({})),
  },
  divIcon: vi.fn(() => ({})),
  latLngBounds: vi.fn(() => ({})),
}));

vi.mock('leaflet/dist/leaflet.css', () => ({}));

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
  serial_number: 'SN12345678',
  hardware_uuid: '550e8400-e29b-41d4-a716-446655440000',
  mac_address: 'AA:BB:CC:DD:EE:FF',
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setupUser('operator');
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

  // T10: PBA Recovery panel tests

  it('T10: shows PBA Active badge when pba_active=true in lockdown detail', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/devices/1') && !url.includes('location')) {
        return Promise.resolve({ data: { ...baseDevice, status: 'stolen' } });
      }
      if (url.startsWith('/audit')) {
        return Promise.resolve({
          data: [{
            id: 'a1',
            action: 'agent_lockdown_confirmed',
            detail: {
              lockdown_effective: true,
              boot_lock_detail: {
                hp_uefi: { pba_active: true, critical_applied: 2 },
                critical_applied_total: 2,
              },
            },
            timestamp: '2025-01-01T00:00:00Z',
          }],
        });
      }
      return Promise.resolve({ data: [] });
    });

    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText('PBA Active')).toBeInTheDocument();
    });
  });

  it('T10: shows PBA Recovery panel with Show Credentials button when PBA active', async () => {
    setupUser('super-admin');
    api.get.mockImplementation((url) => {
      if (url.startsWith('/devices/1') && !url.includes('location')) {
        return Promise.resolve({ data: { ...baseDevice, status: 'stolen' } });
      }
      if (url.startsWith('/audit')) {
        return Promise.resolve({
          data: [{
            id: 'a1',
            action: 'agent_lockdown_confirmed',
            detail: {
              lockdown_effective: true,
              boot_lock_detail: {
                hp_uefi: { pba_active: true, critical_applied: 2 },
                critical_applied_total: 2,
              },
            },
            timestamp: '2025-01-01T00:00:00Z',
          }],
        });
      }
      return Promise.resolve({ data: [] });
    });

    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText('PBA Recovery')).toBeInTheDocument();
    });
    expect(screen.getByText(/Show PBA Credentials/i)).toBeInTheDocument();
    expect(screen.getByText(/Remote unlock will not work/i)).toBeInTheDocument();
  });

  it('T10: does not show PBA Recovery panel when pba_active is false', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/devices/1') && !url.includes('location')) {
        return Promise.resolve({ data: { ...baseDevice, status: 'stolen' } });
      }
      if (url.startsWith('/audit')) {
        return Promise.resolve({
          data: [{
            id: 'a1',
            action: 'agent_lockdown_confirmed',
            detail: {
              lockdown_effective: true,
              boot_lock_detail: {
                hp_uefi: { pba_active: false, critical_applied: 2 },
                critical_applied_total: 2,
              },
            },
            timestamp: '2025-01-01T00:00:00Z',
          }],
        });
      }
      return Promise.resolve({ data: [] });
    });

    renderWithRouter();

    // Wait for page to load
    await waitFor(() => {
      expect(screen.getByText('DEV-001')).toBeInTheDocument();
    });
    expect(screen.queryByText('PBA Recovery')).not.toBeInTheDocument();
    expect(screen.queryByText('PBA Active')).not.toBeInTheDocument();
  });

  it('T10: fetches and displays credentials when Show PBA Credentials clicked', async () => {
    setupUser('super-admin');
    api.get.mockImplementation((url) => {
      if (url.startsWith('/devices/1') && !url.includes('location') && !url.includes('pba-credentials')) {
        return Promise.resolve({ data: { ...baseDevice, status: 'stolen' } });
      }
      if (url.includes('pba-credentials')) {
        return Promise.resolve({
          data: {
            setup_password: 'SetupPw',
            power_on_password: 'PopPw',
            bitlocker_pin: '123456',
            bitlocker_recovery_password: '111111-222222-333333-444444-555555-666666-777777-888888',
          },
        });
      }
      if (url.startsWith('/audit')) {
        return Promise.resolve({
          data: [{
            id: 'a1',
            action: 'agent_lockdown_confirmed',
            detail: {
              lockdown_effective: true,
              boot_lock_detail: {
                hp_uefi: { pba_active: true, critical_applied: 2 },
                critical_applied_total: 2,
              },
            },
            timestamp: '2025-01-01T00:00:00Z',
          }],
        });
      }
      return Promise.resolve({ data: [] });
    });

    renderWithRouter();

    const showBtn = await screen.findByRole('button', { name: /Show PBA Credentials/i });
    fireEvent.click(showBtn);

    await waitFor(() => {
      expect(screen.getByText('BitLocker PIN')).toBeInTheDocument();
    });
    expect(screen.getByText('BitLocker Recovery Password (48-digit)')).toBeInTheDocument();
    expect(screen.getByText('HP Power-On Password')).toBeInTheDocument();
    expect(screen.getByText('HP Setup Password')).toBeInTheDocument();
  });

  it('T10: shows no credentials message when all are null', async () => {
    setupUser('super-admin');
    api.get.mockImplementation((url) => {
      if (url.startsWith('/devices/1') && !url.includes('location') && !url.includes('pba-credentials')) {
        return Promise.resolve({ data: { ...baseDevice, status: 'stolen' } });
      }
      if (url.includes('pba-credentials')) {
        return Promise.resolve({
          data: {
            setup_password: null,
            power_on_password: null,
            bitlocker_pin: null,
            bitlocker_recovery_password: null,
          },
        });
      }
      if (url.startsWith('/audit')) {
        return Promise.resolve({
          data: [{
            id: 'a1',
            action: 'agent_lockdown_confirmed',
            detail: {
              lockdown_effective: true,
              boot_lock_detail: {
                hp_uefi: { pba_active: true, critical_applied: 2 },
                critical_applied_total: 2,
              },
            },
            timestamp: '2025-01-01T00:00:00Z',
          }],
        });
      }
      return Promise.resolve({ data: [] });
    });

    renderWithRouter();

    const showBtn = await screen.findByRole('button', { name: /Show PBA Credentials/i });
    fireEvent.click(showBtn);

    await waitFor(() => {
      expect(screen.getByText(/No PBA credentials found for this device/i)).toBeInTheDocument();
    });
  });

  it('T10: does not show PBA Recovery panel for active (non-locked) devices', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/devices/1') && !url.includes('location')) {
        return Promise.resolve({ data: { ...baseDevice, status: 'active' } });
      }
      if (url.startsWith('/audit')) {
        return Promise.resolve({
          data: [{
            id: 'a1',
            action: 'agent_lockdown_confirmed',
            detail: {
              lockdown_effective: true,
              boot_lock_detail: {
                hp_uefi: { pba_active: true, critical_applied: 2 },
                critical_applied_total: 2,
              },
            },
            timestamp: '2025-01-01T00:00:00Z',
          }],
        });
      }
      return Promise.resolve({ data: [] });
    });

    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText('DEV-001')).toBeInTheDocument();
    });
    expect(screen.queryByText('PBA Recovery')).not.toBeInTheDocument();
  });

  it('T10: does not show PBA Recovery panel for operator role (super-admin only)', async () => {
    // setupUser('operator') is already set in beforeEach
    api.get.mockImplementation((url) => {
      if (url.startsWith('/devices/1') && !url.includes('location')) {
        return Promise.resolve({ data: { ...baseDevice, status: 'stolen' } });
      }
      if (url.startsWith('/audit')) {
        return Promise.resolve({
          data: [{
            id: 'a1',
            action: 'agent_lockdown_confirmed',
            detail: {
              lockdown_effective: true,
              boot_lock_detail: {
                hp_uefi: { pba_active: true, critical_applied: 2 },
                critical_applied_total: 2,
              },
            },
            timestamp: '2025-01-01T00:00:00Z',
          }],
        });
      }
      return Promise.resolve({ data: [] });
    });

    renderWithRouter();

    // PBA Active badge is visible to all roles
    await waitFor(() => {
      expect(screen.getByText('PBA Active')).toBeInTheDocument();
    });
    // PBA Recovery panel is NOT visible to operators
    expect(screen.queryByText('PBA Recovery')).not.toBeInTheDocument();
    expect(screen.queryByText(/Show PBA Credentials/i)).not.toBeInTheDocument();
  });
});
