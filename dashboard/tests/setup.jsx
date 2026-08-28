import '@testing-library/jest-dom';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Mock localStorage
const localStorageMock = (() => {
  let store = {};
  return {
    getItem: (key) => store[key] ?? null,
    setItem: (key, value) => { store[key] = String(value); },
    removeItem: (key) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();

Object.defineProperty(window, 'localStorage', { value: localStorageMock });

/**
 * Test helper: set up a fake JWT in localStorage with a given role.
 *
 * Usage in beforeEach:
 *   setupUser('operator');  // buttons visible
 *   setupUser('viewer');    // buttons hidden
 *   setupUser('super-admin'); // everything visible
 *
 * The token is a fake 3-part JWT (header.payload.signature) where the
 * payload is a base64-encoded JSON object with id, username, and role.
 * This matches what useCurrentUser() decodes in production.
 */
export function setupUser(role = 'operator') {
  const payload = btoa(JSON.stringify({ id: 'test-user-id', username: 'testuser', role }));
  localStorage.setItem('token', `header.${payload}.signature`);
}

/**
 * Test helper: render a component inside a MemoryRouter.
 *
 * Most page components use react-router hooks (useParams, useNavigate, etc.)
 * and need to be rendered inside a Router. This helper wraps the component
 * in a MemoryRouter with optional initial routes.
 *
 * Usage:
 *   renderWithRouter(<DevicesPage />)
 *   renderWithRouter(<DeviceDetailPage />, { initialEntries: ['/devices/dev-1'] })
 */
export function renderWithRouter(ui, options = {}) {
  const { initialEntries = ['/'] } = options;
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      {ui}
    </MemoryRouter>
  );
}
