# Troubleshooting

- Unhealthy PostgreSQL: use the PostgreSQL 18 mount at `/var/lib/postgresql`, verify the configured password, and inspect `docker compose logs postgres`.
- Setup required (`428`): create the first local administrator through `/api/v1/auth/setup`.
- Authentication fails over plain HTTP: keep `COOKIE_SECURE=false` locally; set it to `true` behind HTTPS.
- Low coverage: inspect event gaps and connector health. FlowMetrics intentionally does not fill missing energy.
- No EcoFlow devices: the live transport is guarded until the official contract and device fixtures are verified; use demo mode.
