Feature: Public Seat Reservation Platform

  Background:
    Given the seat layout is initialized with available seats: "A1", "A2", "A3"

  # =========================================================================
  # PHASE 1: AUTHENTICATION & BUSINESS BOUNDARIES
  # =========================================================================

  Scenario: Reject checkout session creation when user session exceeds the 90-day expiry limit
    Given a user has an expired session token issued 91 days ago
    When the user sends a POST request to "/api/reservations" for seat "A1" with an expired token
    Then the API should respond with a 401 Unauthorized status
    And the system must not modify the database or contact the payment provider

  Scenario*: Prevent a single user from hoarding multiple seats in concurrent pending payment sessions
    Given a user is logged in with a valid authentication session
    And the user already has seat "A1" held in a "PENDING_PAYMENT" state
    When the user sends a POST request to "/api/reservations" for seat "A2"
    Then the API should respond with a 400 Bad Request status
    And the response error code should be "ACTIVE_LOCK_LIMIT_EXCEEDED"
    And the system must not create a checkout session for seat "A2"


  # =========================================================================
  # PHASE 2: CORE ENGINE (THE HAPPY PATH)
  # =========================================================================

  Scenario: Successfully lock seat and finalize reservation via provider webhook
    Given a user is logged in with a valid authentication session
    And seat "A1" is currently "AVAILABLE"
    When the user sends a POST request to "/api/reservations" for seat "A1"
    Then the API should respond with a 201 Created status
    And the response body should contain a secure "checkoutUrl"
    And the database should update the status of seat "A1" to "PENDING_PAYMENT"
    When the payment gateway delivers a secure "payment.succeeded" webhook for seat "A1"
    Then the system should update the status of seat "A1" to "CONFIRMED"
    And the database should permanently assign seat "A1" to the user


  # =========================================================================
  # PHASE 3: SYNCHRONOUS CONCURRENCY CONTROL
  # =========================================================================

  Scenario: Handle simultaneous reservation requests for the same available seat cleanly
    Given "User A" is logged in with a valid authentication session
    And "User B" is logged in with a valid authentication session
    And seat "A1" is currently "AVAILABLE"
    When "User A" and "User B" simultaneously send a POST request to "/api/reservations" for seat "A1"
    Then one user should successfully receive a 201 Created status with a "checkoutUrl"
    And the database must place that winning user's target seat into a "PENDING_PAYMENT" state
    And the losing user should receive a 409 Conflict status
    And the conflict response error code should be "SEAT_ALREADY_OCCUPIED"
    And the losing user's request must not generate a checkout session with the payment provider


  # =========================================================================
  # PHASE 4: TIME-DELAYED STATE TIMEOUTS & LOCAL FAILURES
  # =========================================================================

  Scenario: Instantly release seat lock when payment gateway reports a failed transaction
    Given a user is logged in with a valid authentication session
    And a user initiated a reservation for seat "A2", updating it to "PENDING_PAYMENT" status
    When the payment gateway delivers a "payment.failed" webhook for seat "A2"
    Then the system should process the webhook and immediately update seat "A2" to "AVAILABLE"

  Scenario: Automatically release pending reservation lock if payment webhook times out
    Given a user is logged in with a valid authentication session
    And a user initiated a reservation for seat "A2", updating it to "PENDING_PAYMENT" status
    When 5 minutes elapse without the system receiving any webhook from the payment gateway
    Then the system background worker should expire the pending transaction
    And the database should reset the status of seat "A2" to "AVAILABLE"


  # =========================================================================
  # PHASE 5: DISTRIBUTED RESILIENCE & DATA INTEGRITY
  # =========================================================================

  Scenario*: Process a retried reservation request safely using an Idempotency Key
    Given a user is logged in with a valid authentication session
    And a user sent a POST request to "/api/reservations" for seat "A3" which timed out over the network
    When the user retries the exact same POST request for seat "A3" using an identical "Idempotency-Key" header
    Then the API should recognize the key and safely return the originally generated "checkoutUrl"
    And the database must maintain exactly one "PENDING_PAYMENT" lock on seat "A3"

  Scenario*: Confirm reservation when payment webhook is delayed but the seat remains unbooked
    Given a user named "User A" initiated a reservation for seat "A2"
    And the 5-minute timeout elapsed, resetting seat "A2" back to "AVAILABLE" status
    And no other user has attempted to book seat "A2"
    When the payment gateway late-delivers a delayed "payment.succeeded" webhook for "User A" on seat "A2"
    Then the system should gracefully reclaim and permanently confirm seat "A2" for "User A"

  Scenario*: Execute compensation refund when delayed payment webhook arrives for an already rebooked seat
    Given a user named "User A" initiated a reservation for seat "A3"
    And the 5-minute timeout elapsed, resetting seat "A3" back to "AVAILABLE" status
    And a completely different user named "User B" immediately books and confirms seat "A3" to "CONFIRMED"
    When the payment gateway late-delivers a delayed "payment.succeeded" webhook for "User A" on seat "A3"
    Then the system must detect that seat "A3" is already permanently occupied by "User B"
    And the system must immediately trigger an automated refund to the payment provider API using the chargeId from the webhook
    And the system must log a critical "RECONCILIATION_ALERT" event for audit logging
    And "User A"'s internal system record must be updated to "FAILED_AND_REFUNDED"


  # =========================================================================
  # PHASE 6: OPERATIONAL RECOVERY & WEBHOOK SECURITY
  # =========================================================================

  Scenario*: Gracefully ignore duplicate payment success webhooks to ensure idempotency
    Given seat "A1" has already been successfully updated to "CONFIRMED" via a previous webhook
    When the payment gateway sends a duplicate "payment.succeeded" webhook for the exact same transaction ID
    Then the system must recognize that the reservation is already finalized
    And the API should immediately respond with a 200 OK status
    And the system must not trigger any secondary side effects or re-modify the database

  Scenario*: Reject forged payment webhooks containing invalid cryptographic signatures
    Given seat "A2" is currently in "PENDING_PAYMENT" status
    When an unauthenticated entity sends a fake "payment.succeeded" webhook with a malformed or missing "Provider-Signature" header
    Then the API must instantly reject the request with a 401 Unauthorized status
    And the system must not alter the status of seat "A2" in the database
    And the system should log a high-severity security warning for audit logging

  Scenario*: Fail webhook processing with a server error when database is unreachable to trigger gateway retry
    Given seat "A1" is currently in "PENDING_PAYMENT" status
    And the application database layer becomes completely unresponsive or drops connection
    When the payment gateway delivers a valid "payment.succeeded" webhook for seat "A1"
    Then the webhook endpoint must respond with a 500 Internal Server Error status
    And the payment gateway should retain and schedule the webhook for a future retry attempt

  Scenario*: Route transaction to a human intervention queue when automated refund fails during compensation
    Given user "User A" is owed an automated refund because their late webhook arrived for an already occupied seat
    And the payment provider's downstream refund API returns a 502 Bad Gateway error
    When the system's compensation transaction fails to execute the refund
    Then the system must not drop the error or crash the thread
    And the system must push the failed refund event into a "Dead Letter Queue" or database human-intervention table
    And the system must alert operational teams via a critical log message

  # =========================================================================
  # PHASE 3: PRICING & SEAT TIERS  (out of scope for this iteration)
  # =========================================================================
  #
  # Single-source-of-truth pricing today: payment-api resolves every checkout
  # to the global `RESERVATION_AMOUNT` (default 10.00) and echoes it back so
  # reservation-api can audit from the same number. There is no `seats.price`
  # column and no concept of seat tiers — every seat costs the same.
  #
  # The obvious next refactor when this assumption breaks is:
  #   1. Add `seats.price NUMERIC(10,2) NOT NULL` (with a default that
  #      backfills to `RESERVATION_AMOUNT` for existing rows).
  #   2. `POST /api/checkout/sessions` carries the per-seat price; payment-api
  #      stops looking at `RESERVATION_AMOUNT` and trusts the caller (but
  #      still echoes for audit).
  #   3. The `seats` GET response includes `price` so the UI can show it.
  # Until then, scenarios like "premium A1 costs more than economy A3" or
  # "front-row weekend surcharge" are explicitly out of scope.

  Scenario*: Charge a per-seat price drawn from the seats table instead of a global constant
    Given seat "A1" has a price of "25.00" and seat "A3" has a price of "5.00"
    When a user sends a POST request to "/api/reservations" for seat "A1"
    Then the resulting checkout session's amount must be "25.00", not the global "RESERVATION_AMOUNT"
    And the audit row for the session must record the same per-seat price
    And a separate booking of seat "A3" must produce a checkout session for "5.00"