import { useSearchParams } from 'react-router-dom';
import { MESSAGES, PAYMENT_RESULT } from '../../consts';
import { ResultPendingBanner } from '../../components';
import { useDeliveryPolling } from '../../hooks';

const RESERVATION_WEB_URL = import.meta.env.VITE_RESERVATION_WEB_URL;
if (!RESERVATION_WEB_URL) throw new Error('VITE_RESERVATION_WEB_URL is required');

/**
 * Four-way result rendering: outcome × webhook-delivery. The previous version
 * dead-ended on "sync in progress…" with no way out — even after retries
 * succeeded the banner stayed up because the page never re-checked. We now
 * poll the payment-api delivery-status endpoint until it reports DELIVERED
 * (or FAILED), so the banner clears the moment reservation-api receives the
 * event without forcing the buyer to refresh.
 */
export function ResultPage() {
  const [params] = useSearchParams();
  const status = params.get('status') || 'unknown';
  const sessionId = params.get('sessionId');
  const initialDelivered = params.get('delivered') !== '0';
  const isSuccess = status === PAYMENT_RESULT.SUCCESS;

  const { delivered, pollExhausted } = useDeliveryPolling(sessionId, initialDelivered);

  const heading = isSuccess ? MESSAGES.result.success : MESSAGES.result.failed;
  const detail = isSuccess
    ? delivered
      ? MESSAGES.result.successDetail
      : MESSAGES.result.successPendingDetail
    : delivered
      ? MESSAGES.result.failedDetail
      : MESSAGES.result.failedPendingDetail;

  return (
    <div className="page page--centered">
      <h1 data-testid="result-status">{heading}</h1>
      <p data-testid="result-detail">{detail}</p>
      <ResultPendingBanner delivered={delivered} pollExhausted={pollExhausted} />
      <a href={RESERVATION_WEB_URL} data-testid="back-button" className="button-link">
        {MESSAGES.result.backButton}
      </a>
    </div>
  );
}
