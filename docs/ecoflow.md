# EcoFlow connector status

FlowMetrics treats the official EcoFlow developer platform as the only authority for the production cloud contract. During this build, the public documentation surface could be located but its content was JavaScript-gated and could not be inspected through the available browser connection. Therefore no endpoint, header, signature, topic, rate limit, model field, or payload has been invented.

The repository contains a typed connector boundary and a guarded EcoFlow adapter that accepts no live operation until verified. To enable it responsibly, capture sanitized fixtures from authorized hardware, document the model/capability matrix, implement official authentication and discovery exactly, and add contract/parser tests before changing the guard.

Verified today: connector isolation and secret encryption. Not verified: cloud transport, discovery, telemetry fields, models, or rate limits.
