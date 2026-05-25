import { MESSAGES } from '../../consts';
import type { SessionData } from '../../types';

interface CheckoutSummaryProps {
  session: SessionData;
}

export function CheckoutSummary({ session }: CheckoutSummaryProps) {
  return (
    <>
      <p data-testid="seat-id">
        {MESSAGES.checkout.seatPrefix} <strong>{session.seatId}</strong>
      </p>
      <p data-testid="amount">
        {MESSAGES.checkout.amountPrefix} <strong>${session.amount.toFixed(2)}</strong>
      </p>
    </>
  );
}
