import '@testing-library/jest-dom';
import { vi } from 'vitest';

// Stub the build-time env vars that services read at module load. Without
// these, importing a page that pulls in a service module throws before any
// test runs.
vi.stubEnv('VITE_API_URL', 'http://localhost:3003');
vi.stubEnv('VITE_RESERVATION_WEB_URL', 'http://localhost:3001');
