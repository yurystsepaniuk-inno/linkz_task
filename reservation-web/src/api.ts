import { useMemo } from 'react';
import { useAuth, useClerk } from '@clerk/react';
import axios, { AxiosInstance } from 'axios';

const baseURL = import.meta.env.VITE_API_URL;
if (!baseURL) throw new Error('VITE_API_URL is required');

/**
 * Returns a per-component axios instance pre-wired with Clerk auth. Using
 * Clerk's hooks (`useAuth`, `useClerk`) instead of the `window.Clerk` global
 * keeps the boundary inside React's ownership: the instance refreshes when
 * the session does, and tests can mock the hook directly.
 *
 * The instance is memoized on the hooks' stable identities so consumers can
 * safely use it as a `useEffect`/`useCallback` dependency.
 *
 *   - Request interceptor: attach a fresh ~60s session token per request.
 *     Clerk caches and refreshes silently from the long-lived session, so
 *     this fetches the current token rather than carrying one around.
 *   - Response interceptor: on 401, sign out so Clerk's reactive state
 *     flips and <App> renders the LandingPage instead of a blank screen.
 */
export function useApi(): AxiosInstance {
  const { getToken } = useAuth();
  const { signOut } = useClerk();

  return useMemo(() => {
    const instance = axios.create({ baseURL });
    instance.interceptors.request.use(async (config) => {
      const token = await getToken();
      if (token) config.headers.Authorization = `Bearer ${token}`;
      return config;
    });
    instance.interceptors.response.use(
      (res) => res,
      (err) => {
        if (err.response?.status === 401) {
          void signOut();
        }
        return Promise.reject(err);
      },
    );
    return instance;
  }, [getToken, signOut]);
}
