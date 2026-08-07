# Architecture

The production stack has one FlowMetrics container and standard PostgreSQL. Fastify serves the versioned JSON/SSE API and the compiled React application. Inside the process, vendor connectors emit normalized samples to a collector; PostgreSQL stores them; the integration and event engines update durable analytics; bounded queries feed ECharts and exports.

```text
Browser → Fastify + React → connector / collector / analytics / events → PostgreSQL
```

Connector transport is isolated from normalized telemetry. The deterministic demo connector is the reference implementation. Aggregation uses observed time, while received time remains available for diagnosing delayed messages. Database uniqueness and state tables make replay and restart behavior deterministic.

The Cloud-hosted preview surface is a demo visualization only. The supported product deployment is Docker Compose because durable PostgreSQL storage and local ownership are core requirements.
