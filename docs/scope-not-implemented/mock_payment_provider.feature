Feature: Mock Payment Provider Service

  Background:
    Given the mock payment gateway is running and initialized with valid API credentials
    And a secure webhook signing secret is configured

  # =========================================================================
  # PHASE 1: SESSION MANAGEMENT & INGESTION
  # =========================================================================

  Scenario: Successfully generate a secure hosted checkout session
    When a client system sends an authenticated POST request to "/v1/checkout/sessions" with payload:
      """
      {
        "amount": 5000,
        "currency": "usd",
        "metadata": { "seatId": "A1", "userId": "User A" },
        "expiresInMinutes": 5
      }
      """
    Then the mock provider should respond with a 201 Created status
    And the response body should contain a unique "sessionId" starting with "cs_mock_"
    And the response body should contain a valid "checkoutUrl"
    And the internal state of the session should be set to "OPEN"


  Scenario: Enforce strict checkout session expiration based on custom TTL
    Given a mock checkout session has been created with an "expiresInMinutes" set to 5
    When 5 minutes and 1 second elapse without any user interaction on the hosted page
    Then the mock provider must transition the session state internally to "EXPIRED"
    And any subsequent attempt to post a payment against this "sessionId" must be rejected with a 400 Bad Request error "SESSION_EXPIRED"


  # =========================================================================
  # PHASE 2: WEBHOOK DISPATCH & CRYPTOGRAPHY
  # =========================================================================

  Scenario: Asynchronously dispatch a cryptographically signed success webhook
    Given a mock checkout session exists with state "OPEN" for seat "A1"
    When a simulated user completes the payment form on the hosted checkout page with a valid card
    Then the mock provider must transition the session state to "COMPLETE"
    And the mock provider must send an asynchronous POST request to the client's configured webhook endpoint
    And the webhook payload event type must be "payment.succeeded"
    And the webhook request must contain a valid "Provider-Signature" header generated using the signing secret


  Scenario: Asynchronously dispatch a signed failure webhook upon card decline
    Given a mock checkout session exists with state "OPEN" for seat "A2"
    When a simulated user completes the payment form using a known test-declined card number
    Then the mock provider must transition the session state to "FAILED"
    And the mock provider must send an asynchronous POST request to the client's configured webhook endpoint
    And the webhook payload event type must be "payment.failed"
    And the webhook request must contain a valid "Provider-Signature" header matching the failed payload


  # =========================================================================
  # PHASE 3: FAULT INJECTION & OPERATIONAL SIMULATION
  # =========================================================================

  Scenario: Simulate network latency by delaying webhook dispatch on demand
    Given a mock checkout session has been initialized with a metadata flag "simulate_lag_seconds: 420"
    When a simulated user completes the payment form on the hosted checkout page
    Then the mock provider must capture the payment instantly
    And the mock provider must wait exactly 420 seconds before attempting to dispatch the "payment.succeeded" webhook to the client


  Scenario: Execute a retry policy with exponential backoff when the client endpoint is unreachable
    Given a mock checkout session is completed and a "payment.succeeded" webhook is generated
    When the mock provider dispatches the webhook to the client endpoint and receives a 500 Internal Server Error status
    Then the mock provider must register a delivery failure
    And the mock provider must queue the webhook for a retry attempt
    And the mock provider should execute up to 3 retry attempts before moving the event to an internal dead-letter log

  # =========================================================================
  # PHASE 4: REFUND MANAGEMENT (COMPENSATION WORKFLOWS)
  # =========================================================================

  Scenario: Successfully process an automated compensation refund request
    Given the mock payment gateway is running and initialized with valid API credentials
    When a client system sends an authenticated POST request to "/v1/refunds" with payload:
      """
      {
        "chargeId": "ch_mock_12345",
        "amount": 5000,
        "reason": "LATE_WEBHOOK_SEAT_REBOOKED"
      }
      """
    Then the mock provider should respond with a 200 OK status
    And the response body should contain a unique "refundId" starting with "ref_mock_"
    And the internal SQLite state of the transaction should be marked as "REFUNDED"

  Scenario: Simulate downstream gateway failure during a refund request
    Given the mock payment gateway is running and initialized with valid API credentials
    When a client system sends an authenticated POST request to "/v1/refunds" for a chargeId matching a simulated failure condition
    Then the mock provider should respond with a 502 Bad Gateway error