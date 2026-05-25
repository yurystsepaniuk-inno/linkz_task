import React from 'react';
import ReactDOM from 'react-dom/client';
import { ClerkProvider } from '@clerk/react';
import { App } from './App';
import './styles.css';

// @clerk/react@6 requires `publishableKey` in its types; we source it from
// VITE_CLERK_PUBLISHABLE_KEY so it stays a build-time env var, not a literal.
const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
if (!publishableKey) throw new Error('VITE_CLERK_PUBLISHABLE_KEY is required');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ClerkProvider publishableKey={publishableKey} afterSignOutUrl="/">
      <App />
    </ClerkProvider>
  </React.StrictMode>,
);
