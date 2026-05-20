import { useState, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { isAxiosError } from 'axios';
import { MESSAGES } from '../messages';

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      navigate('/seats');
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 401) {
        setError(MESSAGES.login.invalidCredentials);
      } else {
        setError(MESSAGES.login.genericError);
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page page--narrow">
      <h1>{MESSAGES.login.title}</h1>
      <form onSubmit={handleSubmit}>
        <div className="form-field">
          <label>{MESSAGES.login.emailLabel}<br />
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="form-field__input"
              data-testid="email-input"
            />
          </label>
        </div>
        <div className="form-field">
          <label>{MESSAGES.login.passwordLabel}<br />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="form-field__input"
              data-testid="password-input"
            />
          </label>
        </div>
        {error && <p className="error-text" data-testid="login-error">{error}</p>}
        <button type="submit" disabled={loading} className="button">
          {loading ? MESSAGES.login.submitting : MESSAGES.login.submit}
        </button>
      </form>
    </div>
  );
}
