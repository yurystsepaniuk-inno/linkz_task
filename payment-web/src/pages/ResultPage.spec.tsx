import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ResultPage from './ResultPage';

function renderResult(status: string) {
  return render(
    <MemoryRouter initialEntries={[`/result?status=${status}`]}>
      <Routes>
        <Route path="/result" element={<ResultPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ResultPage', () => {
  it('shows success status', () => {
    renderResult('success');
    expect(screen.getByTestId('result-status')).toHaveTextContent('Successful');
  });

  it('shows failed status', () => {
    renderResult('failed');
    expect(screen.getByTestId('result-status')).toHaveTextContent('Failed');
  });

  it('Back button points to reservation-web URL', () => {
    renderResult('success');
    const btn = screen.getByTestId('back-button');
    expect(btn).toHaveAttribute('href', 'http://localhost:3001');
  });
});
