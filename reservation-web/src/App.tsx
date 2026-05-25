import { SignedIn, SignedOut } from '@clerk/clerk-react';
import { LandingPage, SeatsPage } from './pages';

// Auth gating is delegated entirely to Clerk: <SignedIn>/<SignedOut> swap
// the view on session state, so there is no ProtectedRoute and no client-side
// router.
export function App() {
  return (
    <>
      <SignedOut>
        <LandingPage />
      </SignedOut>
      <SignedIn>
        <SeatsPage />
      </SignedIn>
    </>
  );
}
