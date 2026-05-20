import { useSearchParams } from 'react-router-dom';
import { PAYMENT_RESULT } from '../constants';
import { MESSAGES } from '../messages';

const RESERVATION_WEB_URL = import.meta.env.VITE_RESERVATION_WEB_URL;
if (!RESERVATION_WEB_URL) throw new Error('VITE_RESERVATION_WEB_URL is required');

export default function ResultPage() {
  const [params] = useSearchParams();
  const status = params.get('status') || 'unknown';
  const isSuccess = status === PAYMENT_RESULT.SUCCESS;

  return (
    <div className="page page--centered">
      <h1 data-testid="result-status">
        {isSuccess ? MESSAGES.result.success : MESSAGES.result.failed}
      </h1>
      <p>{isSuccess ? MESSAGES.result.successDetail : MESSAGES.result.failedDetail}</p>
      <a href={RESERVATION_WEB_URL} data-testid="back-button" className="button-link">
        {MESSAGES.result.backButton}
      </a>
    </div>
  );
}
