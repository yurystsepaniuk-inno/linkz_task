import { SignInButton, SignUpButton } from '@clerk/react';
import { MESSAGES } from '../../consts';

export function LandingPage() {
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
