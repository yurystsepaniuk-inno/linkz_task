import { MESSAGES } from '../../consts';
import { CheckoutForm, CheckoutSummary } from '../../components';
import { useCheckout } from '../../hooks';

export function CheckoutPage() {
  const { session, error, cardNumber, paying, setCardNumber, handlePay } = useCheckout();

  if (error && !session) {
    return (
      <div className="page">
        <p data-testid="checkout-error" className="error-text">
          {error}
        </p>
      </div>
    );
  }

  if (!session) {
    return <div className="page">{MESSAGES.checkout.loading}</div>;
  }

  return (
    <div className="page">
      <h1>{MESSAGES.checkout.title}</h1>
      <CheckoutSummary session={session} />
      <CheckoutForm
        cardNumber={cardNumber}
        paying={paying}
        error={error}
        onCardNumberChange={setCardNumber}
        onSubmit={handlePay}
      />
    </div>
  );
}
