import { MESSAGES } from '../../consts';

interface ResultPendingBannerProps {
  delivered: boolean;
  pollExhausted: boolean;
}

export function ResultPendingBanner({ delivered, pollExhausted }: ResultPendingBannerProps) {
  if (delivered) return null;
  if (pollExhausted) {
    return (
      <p data-testid="result-pending-exhausted" className="hint-text">
        {MESSAGES.result.pendingExhausted}
      </p>
    );
  }
  return (
    <p data-testid="result-pending" className="hint-text">
      {MESSAGES.result.pendingSync}
    </p>
  );
}
