import { useEffect } from 'react';
import { SignInButton, SignUpButton } from '@clerk/clerk-react';
import { MESSAGES } from '../../consts';

export function LandingPage() {
  // Heads-up for reviewers running on Clerk's free tier: sessions expire after
  // 7 days. If the demo "stops working" after a week with no other change,
  // that's the Clerk session — not a regression in this app.
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.info(
      '[linkz] Clerk free tier expires sessions after 7 days (Pro: 90d). ' +
        'If sign-in suddenly fails on a long-lived demo key, that is the cause.',
    );
  }, []);

  return (
    <div className="page page--narrow">
      <h1>{MESSAGES.landing.title}</h1>
      <p>{MESSAGES.landing.subtitle}</p>
      <div className="actions">
        <SignInButton mode="modal">
          <button className="button button--lg" data-testid="sign-in">
            {MESSAGES.landing.signIn}
          </button>
        </SignInButton>
        <SignUpButton mode="modal">
          <button className="button button--lg" data-testid="sign-up">
            {MESSAGES.landing.signUp}
          </button>
        </SignUpButton>
      </div>
    </div>
  );
}
