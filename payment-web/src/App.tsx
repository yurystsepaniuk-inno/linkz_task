import { Routes, Route } from 'react-router-dom';
import { CheckoutPage, ResultPage } from './pages';

export function App() {
  return (
    <Routes>
      <Route path="/checkout/:sessionId" element={<CheckoutPage />} />
      <Route path="/result" element={<ResultPage />} />
    </Routes>
  );
}
