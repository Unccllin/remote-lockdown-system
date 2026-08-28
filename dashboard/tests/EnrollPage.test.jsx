import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import EnrollPage from '../src/pages/EnrollPage';
import { setupUser, renderWithRouter } from './setup';

// Mock the API client
vi.mock('../src/api/client', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

// Mock useServerlessMode
vi.mock('../src/hooks/useServerlessMode', () => ({
  useServerlessMode: vi.fn(() => ({ serverless: false })),
}));

import api from '../src/api/client';
import { useServerlessMode } from '../src/hooks/useServerlessMode';

// Mock URL.createObjectURL and revokeObjectURL
const mockCreateObjectURL = vi.fn(() => 'blob:test-url');
const mockRevokeObjectURL = vi.fn();
Object.defineProperty(URL, 'createObjectURL', { value: mockCreateObjectURL });
Object.defineProperty(URL, 'revokeObjectURL', { value: mockRevokeObjectURL });

// Mock document.createElement for download links
const mockClick = vi.fn();
const originalCreateElement = document.createElement.bind(document);

const mockDevice = {
  id: 'dev-001',
  hostname: 'TEST-LAPTOP-001',
  owner_name: 'Test Owner',
  status: 'active',
  api_key: 'test-api-key-12345',
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setupUser('super-admin');
  useServerlessMode.mockReturnValue({ serverless: false });
  api.post.mockResolvedValue({ data: mockDevice });
  api.get.mockResolvedValue({ data: new Blob(['fake-zip'], { type: 'application/zip' }) });

  // Reset URL mocks
  mockCreateObjectURL.mockClear();
  mockRevokeObjectURL.mockClear();
});

describe('EnrollPage', () => {
  describe('Enrollment form', () => {
    it('renders the enrollment form with hostname and owner fields', () => {
      renderWithRouter(<EnrollPage />);
      expect(screen.getByText('Enroll a Device')).toBeTruthy();
      expect(screen.getByPlaceholderText('e.g. AGENT-LAPTOP-001')).toBeTruthy();
      expect(screen.getByPlaceholderText('e.g. John Doe')).toBeTruthy();
    });

    it('has a back to devices button', () => {
      renderWithRouter(<EnrollPage />);
      expect(screen.getByText('Back to Devices')).toBeTruthy();
    });

    it('submits the form and calls POST /devices', async () => {
      renderWithRouter(<EnrollPage />);
      const hostnameInput = screen.getByPlaceholderText('e.g. AGENT-LAPTOP-001');
      const ownerInput = screen.getByPlaceholderText('e.g. John Doe');

      fireEvent.change(hostnameInput, { target: { value: 'NEW-DEVICE-001' } });
      fireEvent.change(ownerInput, { target: { value: 'Jane Doe' } });
      fireEvent.click(screen.getByText('Enroll Device'));

      await waitFor(() => {
        expect(api.post).toHaveBeenCalledWith('/devices', {
          hostname: 'NEW-DEVICE-001',
          owner_name: 'Jane Doe',
        });
      });
    });

    it('shows error toast when enrollment fails', async () => {
      api.post.mockRejectedValue({
        response: { data: { error: 'Hostname already exists' } },
      });
      renderWithRouter(<EnrollPage />);
      fireEvent.change(screen.getByPlaceholderText('e.g. AGENT-LAPTOP-001'), {
        target: { value: 'DUP-001' },
      });
      fireEvent.change(screen.getByPlaceholderText('e.g. John Doe'), {
        target: { value: 'Jane' },
      });
      fireEvent.click(screen.getByText('Enroll Device'));

      await waitFor(() => {
        expect(api.post).toHaveBeenCalled();
      });
    });
  });

  describe('Enrollment success view', () => {
    async function enrollDevice() {
      renderWithRouter(<EnrollPage />);
      fireEvent.change(screen.getByPlaceholderText('e.g. AGENT-LAPTOP-001'), {
        target: { value: 'TEST-LAPTOP-001' },
      });
      fireEvent.change(screen.getByPlaceholderText('e.g. John Doe'), {
        target: { value: 'Test Owner' },
      });
      fireEvent.click(screen.getByText('Enroll Device'));
      await waitFor(() => {
        expect(screen.getByText('Device Enrolled')).toBeTruthy();
      });
    }

    it('shows device details after successful enrollment', async () => {
      await enrollDevice();
      expect(screen.getByText('TEST-LAPTOP-001')).toBeTruthy();
      expect(screen.getByText('Test Owner')).toBeTruthy();
      expect(screen.getByText('dev-001')).toBeTruthy();
    });

    it('shows the API key with copy button', async () => {
      await enrollDevice();
      expect(screen.getByText('test-api-key-12345')).toBeTruthy();
      expect(screen.getByText('Copy')).toBeTruthy();
    });

    it('shows download config button', async () => {
      await enrollDevice();
      expect(screen.getByText('Config JSON')).toBeTruthy();
    });

    it('shows download setup script button', async () => {
      await enrollDevice();
      expect(screen.getByText('Setup Script')).toBeTruthy();
    });

    it('shows one-click installer button (non-serverless)', async () => {
      await enrollDevice();
      expect(screen.getByText('Download Windows Installer (.exe)')).toBeTruthy();
    });

    it('shows ZIP installer options (Windows + Linux)', async () => {
      await enrollDevice();
      expect(screen.getByText('Windows ZIP')).toBeTruthy();
      expect(screen.getByText('Linux ZIP')).toBeTruthy();
    });

    it('shows View Device Details and Enroll Another buttons', async () => {
      await enrollDevice();
      expect(screen.getByText('View Device Details')).toBeTruthy();
      expect(screen.getByText('Enroll Another Device')).toBeTruthy();
    });
  });

  describe('Serverless mode', () => {
    it('hides installer download buttons in serverless mode', async () => {
      useServerlessMode.mockReturnValue({ serverless: true });
      renderWithRouter(<EnrollPage />);
      fireEvent.change(screen.getByPlaceholderText('e.g. AGENT-LAPTOP-001'), {
        target: { value: 'TEST-001' },
      });
      fireEvent.change(screen.getByPlaceholderText('e.g. John Doe'), {
        target: { value: 'Owner' },
      });
      fireEvent.click(screen.getByText('Enroll Device'));

      await waitFor(() => {
        expect(screen.getByText('Device Enrolled')).toBeTruthy();
      });

      // Should show the "unavailable" message instead of installer buttons
      expect(screen.getByText('Installer downloads unavailable')).toBeTruthy();
      expect(screen.queryByText('Download Windows Installer (.exe)')).toBeNull();
    });
  });

  describe('Download functionality', () => {
    it('triggers blob download when Config JSON button is clicked', async () => {
      await renderWithRouter(<EnrollPage />);
      fireEvent.change(screen.getByPlaceholderText('e.g. AGENT-LAPTOP-001'), {
        target: { value: 'TEST-LAPTOP-001' },
      });
      fireEvent.change(screen.getByPlaceholderText('e.g. John Doe'), {
        target: { value: 'Test Owner' },
      });
      fireEvent.click(screen.getByText('Enroll Device'));

      await waitFor(() => {
        expect(screen.getByText('Config JSON')).toBeTruthy();
      });

      // Click the config download button
      fireEvent.click(screen.getByText('Config JSON'));

      // Should have created a blob URL
      await waitFor(() => {
        expect(mockCreateObjectURL).toHaveBeenCalled();
      });
    });

    it('calls API when ZIP installer button is clicked', async () => {
      renderWithRouter(<EnrollPage />);
      fireEvent.change(screen.getByPlaceholderText('e.g. AGENT-LAPTOP-001'), {
        target: { value: 'TEST-LAPTOP-001' },
      });
      fireEvent.change(screen.getByPlaceholderText('e.g. John Doe'), {
        target: { value: 'Test Owner' },
      });
      fireEvent.click(screen.getByText('Enroll Device'));

      await waitFor(() => {
        expect(screen.getByText('Windows ZIP')).toBeTruthy();
      });

      fireEvent.click(screen.getByText('Windows ZIP'));

      await waitFor(() => {
        expect(api.get).toHaveBeenCalledWith(
          '/installer/dev-001?platform=win',
          { responseType: 'blob' }
        );
      });
    });

    it('calls API when one-click installer button is clicked', async () => {
      renderWithRouter(<EnrollPage />);
      fireEvent.change(screen.getByPlaceholderText('e.g. AGENT-LAPTOP-001'), {
        target: { value: 'TEST-LAPTOP-001' },
      });
      fireEvent.change(screen.getByPlaceholderText('e.g. John Doe'), {
        target: { value: 'Test Owner' },
      });
      fireEvent.click(screen.getByText('Enroll Device'));

      await waitFor(() => {
        expect(screen.getByText('Download Windows Installer (.exe)')).toBeTruthy();
      });

      fireEvent.click(screen.getByText('Download Windows Installer (.exe)'));

      await waitFor(() => {
        expect(api.get).toHaveBeenCalledWith(
          '/installer/dev-001/nsis',
          { responseType: 'blob' }
        );
      });
    });
  });
});
