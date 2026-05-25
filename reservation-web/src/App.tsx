import { Show } from '@clerk/react';
import SeatsPage from './pages/SeatsPage';
import LandingPage from './pages/LandingPage';

// Auth gating is delegated entirely to Clerk: <Show> swaps the view on the
// session state, so there is no ProtectedRoute and no client-side router.
export default function App() {
  return (
    <>
      <Show when="signed-out">
        <LandingPage />
      </Show>
      <Show when="signed-in">
        <SeatsPage />
      </Show>
    </>
  );
}
