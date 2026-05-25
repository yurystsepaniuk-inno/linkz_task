/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string;
  readonly VITE_CLERK_PUBLISHABLE_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Minimal structural type for the Clerk instance the SDK puts on `window`.
interface Window {
  Clerk?: {
    session?: { getToken(): Promise<string | null> };
    signOut?: () => Promise<void>;
  };
}
