export const MESSAGES = {
  login: {
    title: 'Seat Reservation — Login',
    emailLabel: 'Email',
    passwordLabel: 'Password',
    submit: 'Login',
    submitting: 'Logging in…',
    invalidCredentials: 'Invalid email or password',
    genericError: 'Login failed. Please try again.',
  },
  seats: {
    title: 'Seat Reservation',
    logout: 'Logout',
    book: 'Book',
    booking: 'Booking…',
    refresh: 'Refresh',
    seatTaken: 'Seat already taken',
    bookingFailed: 'Booking failed. Please try again.',
    loadFailed: 'Could not load seats. Please refresh.',
  },
} as const;
