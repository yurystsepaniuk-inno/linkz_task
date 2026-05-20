Feature: Mock Payment Gateway Service

  Scenario: Successfully create a checkout session for a pending reservation
    When the reservation platform requests a checkout session for seat "A1" with userId "user-1" and an amount of 10.00
    Then the payment service should return a 201 Created status
    And the response must contain a unique "sessionId" and a "checkoutUrl"

  Scenario: Dispatch a signed webhook upon successful payment simulation
    Given an active checkout session exists for seat "A1" owned by userId "user-1"
    When the payment service simulates a successful transaction for this session
    Then the payment service must send a POST request to the platform's webhook endpoint
    And the headers must include a valid cryptographic signature (e.g., "X-Signature")
    And the webhook payload must contain the event "payment.succeeded", reference seat "A1", and include userId "user-1"

  Scenario: Dispatch a signed webhook upon failed payment simulation
    Given an active checkout session exists for seat "A2" owned by userId "user-2"
    When the payment service simulates a failed transaction for this session
    Then the payment service must send a POST request to the platform's webhook endpoint
    And the headers must include a valid cryptographic signature (e.g., "X-Signature")
    And the webhook payload must contain the event "payment.failed", reference seat "A2", and include userId "user-2"