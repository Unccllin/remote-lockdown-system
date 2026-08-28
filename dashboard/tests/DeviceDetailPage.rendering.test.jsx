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

  it('displays hardware identifiers in the Hardware Identity section', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/devices/1') && !url.includes('location')) {
        return Promise.resolve({ data: baseDevice });
      }
      return Promise.resolve({ data: [] });
    });

    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText('Hardware Identity')).toBeInTheDocument();
    }, { timeout: 3000 });
    expect(screen.getByText('Serial Number')).toBeInTheDocument();
    expect(screen.getByText('SN12345678')).toBeInTheDocument();
    expect(screen.getByText('Hardware UUID')).toBeInTheDocument();
    expect(screen.getByText('550e8400-e29b-41d4-a716-446655440000')).toBeInTheDocument();
    expect(screen.getByText('MAC Address')).toBeInTheDocument();
    expect(screen.getByText('AA:BB:CC:DD:EE:FF')).toBeInTheDocument();
  });

  it('shows N/A for missing hardware identifiers', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/devices/1') && !url.includes('location')) {
        return Promise.resolve({
          data: {
            ...baseDevice,
            serial_number: null,
            hardware_uuid: null,
            mac_address: null,
          },
        });
      }
      return Promise.resolve({ data: [] });
    });

    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText('Hardware Identity')).toBeInTheDocument();
    }, { timeout: 3000 });
    // Three "N/A" values for the three missing identifiers
    expect(screen.getAllByText('N/A').length).toBe(3);
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
      // "Latest Location" appears in both the map popup and the details card heading
      const elements = screen.getAllByText('Latest Location');
      expect(elements.length).toBeGreaterThan(0);
    }, { timeout: 3000 });
  });

  // Phase 17: Lockdown-effectiveness panel tests

  it('shows BOOT LOCKDOWN INEFFECTIVE warning when lockdown_effective=false', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/devices/1') && !url.includes('location')) {
        return Promise.resolve({ data: { ...baseDevice, status: 'locked' } });
      }
      if (url.startsWith('/audit')) {
        return Promise.resolve({
          data: [{
            id: 'a1',
            action: 'agent_lockdown_confirmed',
            detail: {
              command_id: 'cmd-1',
              boot_lock_status: 'partial',
              lockdown_effective: false,
              boot_lock_detail: {
                boot_lock_attempted: true,
                bcd: { critical_applied: 0, best_effort_applied: 0, best_effort_failed: 0, rolled_back: true },
                hp_uefi: { not_hp: true, critical_applied: 0, best_effort_applied: 0, best_effort_failed: 0 },
                critical_applied_total: 0,
                best_effort_applied_total: 0,
                best_effort_failed_total: 0,
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
      expect(screen.getByText('BOOT LOCKDOWN INEFFECTIVE')).toBeInTheDocument();
    }, { timeout: 3000 });
    // Should also show the warning explanation
    expect(screen.getByText(/zero critical boot-lockdown/i)).toBeInTheDocument();
  });

  it('shows Boot lockdown applied when lockdown_effective=true', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/devices/1') && !url.includes('location')) {
        return Promise.resolve({ data: { ...baseDevice, status: 'locked' } });
      }
      if (url.startsWith('/audit')) {
        return Promise.resolve({
          data: [{
            id: 'a1',
            action: 'agent_lockdown_confirmed',
            detail: {
              command_id: 'cmd-1',
              boot_lock_status: null,
              lockdown_effective: true,
              boot_lock_detail: {
                boot_lock_attempted: true,
                bcd: { critical_applied: 3, best_effort_applied: 2, best_effort_failed: 0 },
                hp_uefi: { not_hp: false, critical_applied: 5, best_effort_applied: 1, best_effort_failed: 0 },
                critical_applied_total: 8,
                best_effort_applied_total: 3,
                best_effort_failed_total: 0,
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
      expect(screen.getByText('Boot lockdown applied')).toBeInTheDocument();
    }, { timeout: 3000 });
    // Should NOT show the ineffective warning
    expect(screen.queryByText(/zero critical boot-lockdown/i)).not.toBeInTheDocument();
  });

  it('does not show lockdown panel when lockdown_effective is null', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/devices/1') && !url.includes('location')) {
        return Promise.resolve({ data: { ...baseDevice, status: 'locked' } });
      }
      if (url.startsWith('/audit')) {
        return Promise.resolve({
          data: [{
            id: 'a1',
            action: 'agent_lockdown_confirmed',
            detail: {
              command_id: 'cmd-1',
              boot_lock_status: null,
              lockdown_effective: null,
            },
            timestamp: '2025-01-01T00:00:00Z',
          }],
        });
      }
      return Promise.resolve({ data: [] });
    });

    renderWithRouter();

    // Wait for the page to load
    await waitFor(() => {
      expect(screen.getByText('DEV-001')).toBeInTheDocument();
    }, { timeout: 3000 });
    // Should NOT show the lockdown panel
    expect(screen.queryByText('Lockdown Effectiveness')).not.toBeInTheDocument();
  });

  it('does not show lockdown panel for active (non-locked) devices', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/devices/1') && !url.includes('location')) {
        return Promise.resolve({ data: baseDevice }); // status: active
      }
      if (url.startsWith('/audit')) {
        return Promise.resolve({
          data: [{
            id: 'a1',
            action: 'agent_lockdown_confirmed',
            detail: {
              command_id: 'cmd-1',
              lockdown_effective: false,
              boot_lock_detail: { boot_lock_attempted: true, critical_applied_total: 0 },
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
    }, { timeout: 3000 });
    expect(screen.queryByText('Lockdown Effectiveness')).not.toBeInTheDocument();
  });

  it('handles detail as JSON string (SQLite compatibility)', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/devices/1') && !url.includes('location')) {
        return Promise.resolve({ data: { ...baseDevice, status: 'locked' } });
      }
      if (url.startsWith('/audit')) {
        return Promise.resolve({
          data: [{
            id: 'a1',
            action: 'agent_lockdown_confirmed',
            // SQLite returns detail as a JSON string, not a parsed object
            detail: JSON.stringify({
              command_id: 'cmd-1',
              boot_lock_status: 'partial',
              lockdown_effective: false,
              boot_lock_detail: {
                boot_lock_attempted: true,
                bcd: { critical_applied: 0, best_effort_applied: 0, best_effort_failed: 0 },
                hp_uefi: { not_hp: true, critical_applied: 0, best_effort_applied: 0, best_effort_failed: 0 },
                critical_applied_total: 0,
              },
            }),
            timestamp: '2025-01-01T00:00:00Z',
          }],
        });
      }
      return Promise.resolve({ data: [] });
    });

    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText('BOOT LOCKDOWN INEFFECTIVE')).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  // D-011: Encryption blocked files panel tests

  it('D-011: shows Encryption Blocked Files panel when files are blocked', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/devices/1') && !url.includes('location')) {
        return Promise.resolve({ data: { ...baseDevice, status: 'locked' } });
      }
      if (url.startsWith('/audit')) {
        return Promise.resolve({
          data: [{
            id: 'a1',
            action: 'agent_lockdown_confirmed',
            detail: {
              command_id: 'cmd-1',
              boot_lock_status: null,
              lockdown_effective: true,
              boot_lock_detail: {
                boot_lock_attempted: true,
                bcd: { critical_applied: 3, best_effort_applied: 2, best_effort_failed: 0 },
                hp_uefi: { not_hp: true, critical_applied: 0, best_effort_applied: 0, best_effort_failed: 0 },
                critical_applied_total: 3,
              },
              encryption_blocked_files: ['docs/secret.xlsx', 'data/outlook.pst'],
            },
            timestamp: '2025-01-01T00:00:00Z',
          }],
        });
      }
      return Promise.resolve({ data: [] });
    });

    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText('Encryption Blocked Files')).toBeInTheDocument();
    }, { timeout: 3000 });
    expect(screen.getByText('2 file(s) not encrypted')).toBeInTheDocument();
    expect(screen.getByText('docs/secret.xlsx')).toBeInTheDocument();
    expect(screen.getByText('data/outlook.pst')).toBeInTheDocument();
  });

  it('D-011: does not show Encryption Blocked Files panel when no files blocked', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/devices/1') && !url.includes('location')) {
        return Promise.resolve({ data: { ...baseDevice, status: 'locked' } });
      }
      if (url.startsWith('/audit')) {
        return Promise.resolve({
          data: [{
            id: 'a1',
            action: 'agent_lockdown_confirmed',
            detail: {
              command_id: 'cmd-1',
              boot_lock_status: null,
              lockdown_effective: true,
              boot_lock_detail: {
                boot_lock_attempted: true,
                bcd: { critical_applied: 3, best_effort_applied: 2, best_effort_failed: 0 },
                hp_uefi: { not_hp: true, critical_applied: 0, best_effort_applied: 0, best_effort_failed: 0 },
                critical_applied_total: 3,
              },
              encryption_blocked_files: [],
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
    }, { timeout: 3000 });
    expect(screen.queryByText('Encryption Blocked Files')).not.toBeInTheDocument();
  });

  // D-010: Sure Admin detection panel tests

  it('D-010: shows HP Sure Admin Detected panel when sure_admin_status is present', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/devices/1') && !url.includes('location')) {
        return Promise.resolve({ data: { ...baseDevice, status: 'locked' } });
      }
      if (url.startsWith('/audit')) {
        return Promise.resolve({
          data: [{
            id: 'a1',
            action: 'agent_lockdown_confirmed',
            detail: {
              command_id: 'cmd-1',
              boot_lock_status: null,
              lockdown_effective: true,
              boot_lock_detail: {
                boot_lock_attempted: true,
                bcd: { critical_applied: 3, best_effort_applied: 2, best_effort_failed: 0 },
                hp_uefi: {
                  not_hp: false,
                  critical_applied: 5,
                  best_effort_applied: 1,
                  best_effort_failed: 0,
                  sure_admin_status: {
                    sure_admin_detected: true,
                    sure_run_detected: false,
                    sure_start_detected: true,
                    any_sure_feature: true,
                    warning: 'HP Sure Admin+Sure Start detected. BIOS changes may be reverted on next boot.',
                  },
                },
                critical_applied_total: 8,
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
      expect(screen.getByText('HP Sure Admin Detected')).toBeInTheDocument();
    }, { timeout: 3000 });
    expect(screen.getByText(/Sure Admin\+Sure Start detected/i)).toBeInTheDocument();
    expect(screen.getByText('Sure Admin')).toBeInTheDocument();
    expect(screen.getByText('Sure Start')).toBeInTheDocument();
  });

  it('D-010: does not show Sure Admin panel when no Sure features detected', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/devices/1') && !url.includes('location')) {
        return Promise.resolve({ data: { ...baseDevice, status: 'locked' } });
      }
      if (url.startsWith('/audit')) {
        return Promise.resolve({
          data: [{
            id: 'a1',
            action: 'agent_lockdown_confirmed',
            detail: {
              command_id: 'cmd-1',
              boot_lock_status: null,
              lockdown_effective: true,
              boot_lock_detail: {
                boot_lock_attempted: true,
                bcd: { critical_applied: 3, best_effort_applied: 2, best_effort_failed: 0 },
                hp_uefi: {
                  not_hp: false,
                  critical_applied: 5,
                  best_effort_applied: 1,
                  best_effort_failed: 0,
                  sure_admin_status: {
                    sure_admin_detected: false,
                    sure_run_detected: false,
                    sure_start_detected: false,
                    any_sure_feature: false,
                    warning: null,
                  },
                },
                critical_applied_total: 8,
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
    }, { timeout: 3000 });
    expect(screen.queryByText('HP Sure Admin Detected')).not.toBeInTheDocument();
  });

  // D-008: BitLocker status panel tests

  it('D-008: shows BitLocker Active panel when bitlocker is enabled', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/devices/1') && !url.includes('location')) {
        return Promise.resolve({ data: { ...baseDevice, status: 'locked' } });
      }
      if (url.startsWith('/audit')) {
        return Promise.resolve({
          data: [{
            id: 'a1',
            action: 'agent_lockdown_confirmed',
            detail: {
              command_id: 'cmd-1',
              boot_lock_status: null,
              lockdown_effective: true,
              boot_lock_detail: {
                boot_lock_attempted: true,
                bcd: {
                  critical_applied: 3,
                  best_effort_applied: 2,
                  best_effort_failed: 0,
                  bitlocker_status: {
                    enabled: true,
                    suspended: false,
                    percentage: '100%',
                    error: null,
                  },
                },
                hp_uefi: { not_hp: true, critical_applied: 0, best_effort_applied: 0, best_effort_failed: 0 },
                critical_applied_total: 3,
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
      expect(screen.getByText('BitLocker Active')).toBeInTheDocument();
    }, { timeout: 3000 });
    expect(screen.getByText('100% encrypted')).toBeInTheDocument();
  });

  it('D-008: does not show BitLocker panel when bitlocker is not enabled', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/devices/1') && !url.includes('location')) {
        return Promise.resolve({ data: { ...baseDevice, status: 'locked' } });
      }
      if (url.startsWith('/audit')) {
        return Promise.resolve({
          data: [{
            id: 'a1',
            action: 'agent_lockdown_confirmed',
            detail: {
              command_id: 'cmd-1',
              boot_lock_status: null,
              lockdown_effective: true,
              boot_lock_detail: {
                boot_lock_attempted: true,
                bcd: {
                  critical_applied: 3,
                  best_effort_applied: 2,
                  best_effort_failed: 0,
                  bitlocker_status: {
                    enabled: false,
                    suspended: false,
                    percentage: '0%',
                    error: null,
                  },
                },
                hp_uefi: { not_hp: true, critical_applied: 0, best_effort_applied: 0, best_effort_failed: 0 },
                critical_applied_total: 3,
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
    }, { timeout: 3000 });
    expect(screen.queryByText('BitLocker Active')).not.toBeInTheDocument();
  });

  // D-007: Session 0 lock context panel tests

  it('D-007: shows Lock Applied from Service Session panel when is_session_zero=true', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/devices/1') && !url.includes('location')) {
        return Promise.resolve({ data: { ...baseDevice, status: 'locked' } });
      }
      if (url.startsWith('/audit')) {
        return Promise.resolve({
          data: [{
            id: 'a1',
            action: 'agent_lockdown_confirmed',
            detail: {
              command_id: 'cmd-1',
              boot_lock_status: null,
              lockdown_effective: true,
              boot_lock_detail: {
                boot_lock_attempted: true,
                bcd: { critical_applied: 3, best_effort_applied: 2, best_effort_failed: 0 },
                hp_uefi: { not_hp: true, critical_applied: 0, best_effort_applied: 0, best_effort_failed: 0 },
                critical_applied_total: 3,
              },
              lock_session_context: {
                is_session_zero: true,
                session_id: 0,
                platform: 'Windows',
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
      expect(screen.getByText('Lock Applied from Service Session')).toBeInTheDocument();
    }, { timeout: 3000 });
    expect(screen.getByText(/Session 0 \(ID: 0\)/i)).toBeInTheDocument();
    expect(screen.getByText(/tsdiscon/i)).toBeInTheDocument();
  });

  it('D-007: does not show Session 0 panel when is_session_zero=false', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/devices/1') && !url.includes('location')) {
        return Promise.resolve({ data: { ...baseDevice, status: 'locked' } });
      }
      if (url.startsWith('/audit')) {
        return Promise.resolve({
          data: [{
            id: 'a1',
            action: 'agent_lockdown_confirmed',
            detail: {
              command_id: 'cmd-1',
              boot_lock_status: null,
              lockdown_effective: true,
              boot_lock_detail: {
                boot_lock_attempted: true,
                bcd: { critical_applied: 3, best_effort_applied: 2, best_effort_failed: 0 },
                hp_uefi: { not_hp: true, critical_applied: 0, best_effort_applied: 0, best_effort_failed: 0 },
                critical_applied_total: 3,
              },
              lock_session_context: {
                is_session_zero: false,
                session_id: 1,
                platform: 'Windows',
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
    }, { timeout: 3000 });
    expect(screen.queryByText('Lock Applied from Service Session')).not.toBeInTheDocument();
  });
});
