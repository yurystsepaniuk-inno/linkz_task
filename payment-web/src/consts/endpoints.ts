export const ENDPOINTS = {
  session: (sessionId: string) => `/api/checkout/sessions/${sessionId}`,
  pay: (sessionId: string) => `/api/checkout/sessions/${sessionId}/pay`,
  deliveryStatus: (sessionId: string) => `/api/checkout/sessions/${sessionId}/delivery-status`,
} as const;
