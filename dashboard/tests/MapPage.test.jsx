import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import MapPage from '../src/pages/MapPage';
import { setupUser } from './setup';

// Mock react-leaflet — Leaflet's MapContainer doesn't work in jsdom
vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }) => <div data-testid="mock-map">{children}</div>,
  TileLayer: () => null,
  Marker: ({ children }) => <div data-testid="mock-marker">{children}</div>,
  Popup: ({ children }) => <div>{children}</div>,
  Circle: () => null,
  useMap: () => ({ setView: vi.fn(), fitBounds: vi.fn(), eachLayer: vi.fn(), removeLayer: vi.fn() }),
}));

vi.mock('leaflet', () => ({
  default: {
    divIcon: vi.fn(() => ({})),
    TileLayer: vi.fn(),
    tileLayer: vi.fn(() => ({ addTo: vi.fn() })),
  },
  divIcon: vi.fn(() => ({})),
  TileLayer: vi.fn(),
  tileLayer: vi.fn(() => ({ addTo: vi.fn() })),
}));

vi.mock('leaflet/dist/leaflet.css', () => ({}));

// Mock the API client
vi.mock('../src/api/client', () => ({
  default: {
    get: vi.fn(),
  },
}));

import api from '../src/api/client';

function renderWithRouter() {
  return render(
    <MemoryRouter initialEntries={['/map']}>
      <Routes>
        <Route path="/map" element={<MapPage />} />
        <Route path="/devices/:id" element={<div data-testid="device-detail">Device Detail</div>} />
      </Routes>
    </MemoryRouter>
  );
}

const mockDevices = [
  { id: 'dev-1', hostname: 'DEV-001', owner_name: 'Alice', status: 'active' },
  { id: 'dev-2', hostname: 'DEV-002', owner_name: 'Bob', status: 'stolen' },
];

const mockLocations = {
  'dev-1': [{ id: 'loc-1', latitude: 37.7749, longitude: -122.4194, reported_at: new Date().toISOString(), city: 'San Francisco', country: 'USA' }],
  'dev-2': [{ id: 'loc-2', latitude: 40.7128, longitude: -74.006, reported_at: new Date().toISOString(), city: 'New York', country: 'USA' }],
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setupUser('operator');
  api.get.mockImplementation((url) => {
    if (url === '/devices') return Promise.resolve({ data: mockDevices });
    if (url.includes('/locations')) {
      const deviceId = url.match(/\/devices\/(.+)\/locations/)[1];
      return Promise.resolve({ data: mockLocations[deviceId] || [] });
    }
    return Promise.resolve({ data: [] });
  });
});

describe('MapPage', () => {
  it('renders page title', async () => {
    renderWithRouter();
    expect(screen.getByText('Device Map')).toBeInTheDocument();
  });

  it('calls GET /devices on mount', async () => {
    renderWithRouter();

    await waitFor(() => {
      expect(api.get).toHaveBeenCalledWith('/devices');
    });
  });

  it('shows Refresh button', async () => {
    renderWithRouter();
    expect(screen.getByText('Refresh')).toBeInTheDocument();
  });

  it('shows map style buttons (Map, Satellite, Hybrid, Terrain)', async () => {
    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByTitle('Map')).toBeInTheDocument();
    });
    expect(screen.getByTitle('Satellite')).toBeInTheDocument();
    expect(screen.getByTitle('Hybrid')).toBeInTheDocument();
    expect(screen.getByTitle('Terrain')).toBeInTheDocument();
  });

  it('renders the map with markers when devices have locations', async () => {
    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByTestId('mock-map')).toBeInTheDocument();
    });
    // Two markers for two located devices
    expect(screen.getAllByTestId('mock-marker').length).toBe(2);
  });

  it('shows device hostnames in popups', async () => {
    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText('DEV-001')).toBeInTheDocument();
    });
    expect(screen.getByText('DEV-002')).toBeInTheDocument();
  });

  it('shows legend with status labels', async () => {
    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText('Legend')).toBeInTheDocument();
    });
    // Status labels appear in both popups and legend — use getAllByText
    expect(screen.getAllByText('active').length).toBeGreaterThan(0);
    expect(screen.getAllByText('stolen').length).toBeGreaterThan(0);
    expect(screen.getAllByText('locked').length).toBeGreaterThan(0);
    expect(screen.getAllByText('tracking').length).toBeGreaterThan(0);
  });

  it('shows empty state when no devices have locations', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/devices') return Promise.resolve({ data: mockDevices });
      if (url.includes('/locations')) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });

    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText(/No devices with location data/i)).toBeInTheDocument();
    });
  });

  it('shows device count in subtitle', async () => {
    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText(/2 devices with location data/)).toBeInTheDocument();
    });
  });

  it('shows View device details link in popup', async () => {
    renderWithRouter();

    await waitFor(() => {
      expect(screen.getAllByText('View device details →').length).toBe(2);
    });
  });

  it('calls location API for each device', async () => {
    renderWithRouter();

    await waitFor(() => {
      expect(api.get).toHaveBeenCalledWith('/devices/dev-1/locations?limit=1');
      expect(api.get).toHaveBeenCalledWith('/devices/dev-2/locations?limit=1');
    });
  });
});
