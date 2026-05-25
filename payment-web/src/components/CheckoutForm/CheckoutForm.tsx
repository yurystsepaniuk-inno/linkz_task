import { FormEvent } from 'react';
import { MESSAGES } from '../../consts';

interface CheckoutFormProps {
  cardNumber: string;
  paying: boolean;
  error: string;
  onCardNumberChange: (value: string) => void;
  onSubmit: (e: FormEvent) => void;
}

export function CheckoutForm({
  cardNumber,
  paying,
  error,
  onCardNumberChange,
  onSubmit,
}: CheckoutFormProps) {
  return (
    <form onSubmit={onSubmit}>
      <div className="form-field">
        <label>
          {MESSAGES.checkout.cardLabel}
          <br />
          <input
            type="text"
            value={cardNumber}
            onChange={(e) => onCardNumberChange(e.target.value)}
            placeholder={MESSAGES.checkout.cardPlaceholder}
            required
            className="form-field__input"
            data-testid="card-input"
          />
        </label>
      </div>
      <p className="hint-text">{MESSAGES.checkout.cardHint}</p>
      {error && (
        <p data-testid="checkout-error" className="error-text">{error}</p>
      )}
      <button type="submit" disabled={paying} data-testid="pay-button" className="button">
        {paying ? MESSAGES.checkout.paying : MESSAGES.checkout.pay}
      </button>
    </form>
  );
}
