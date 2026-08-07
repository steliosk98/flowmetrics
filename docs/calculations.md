# Calculations

For adjacent power samples `P0` and `P1`, FlowMetrics calculates `(P0 + P1) / 2 × elapsed_hours`. It integrates solar, grid, charge, discharge, AC, DC, and total output independently.

Samples are sorted by observed timestamp and duplicates are removed deterministically. An interval larger than `max(3 × expected interval, 120 seconds)` is a gap: no energy is created, gap time increases, and coverage falls. Coverage is valid integration seconds divided by the observed span.

Input solar share is `solar Wh / (solar Wh + grid Wh)`. Equivalent cycles are discharged Wh divided by configured usable capacity; they remain null without capacity. Daily boundaries use each device's IANA timezone and never assume UTC midnight.
