import { Routes, Route } from 'react-router-dom';
import CheckoutPage from './pages/CheckoutPage';
import ResultPage from './pages/ResultPage';

export default function App() {
  return (
    <Routes>
      <Route path="/checkout/:sessionId" element={<CheckoutPage />} />
      <Route path="/result" element={<ResultPage />} />
    </Routes>
  );
}
