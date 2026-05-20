Feature: Public Seat Reservation Platform

  Background:
    Given the seat layout is initialized with available seats: "A1", "A2", "A3"

  Scenario: Reject checkout session creation when user session exceeds the 90-day expiry limit
    Given a user has an expired session token issued 91 days ago
    When the user sends a POST request to "/api/reservations" for seat "A1" with an expired token
    Then the API should respond with a 401 Unauthorized status
    And the system must not modify the database or contact the payment provider

  Scenario: Successfully lock seat and finalize reservation via provider webhook
    Given a user is logged in with a valid authentication session
    And seat "A1" is currently "AVAILABLE"
    When the user sends a POST request to "/api/reservations" for seat "A1"
    Then the API should respond with a 201 Created status
    And the response body should contain a "checkoutUrl"
    And the database should update the status of seat "A1" to "PENDING_PAYMENT"
    When the payment gateway delivers a secure "payment.succeeded" webhook for seat "A1"
    Then the system should update the status of seat "A1" to "CONFIRMED"
    And the database should permanently assign seat "A1" to the user

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