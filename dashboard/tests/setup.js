import '@testing-library/jest-dom';

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
