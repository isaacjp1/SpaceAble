# SpaceAble benchmark

Generated 2026-10-28 by `python -m app.benchmark` on Linux-6.18.33.2-microsoft-standard-WSL2-x86_64-with-glibc2.43, Python 3.12.15, 24 CPUs.
Analysis grid 5 cm; candidate grid 20 cm; optimizer time limit 10 s per room.

**These are synthetic rooms.** They test that the engine is internally consistent and honest about failure. They say nothing about how well it does in real homes.

| fixture | before | search_status | after | alternatives | moved_objects | route_length_cm | solver_time_s | validated | exhaustive | hit_time_limit | grid_misses | verification |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| canonical-bedroom | fail | solutions_found | pass | 2 | 1 | 100.8 | 0.688 | 64 | False | False | 0 | OK |
| feasible-bedroom | pass | solutions_found | pass | 2 | 0 | 118.4 | 2.671 | 230 | False | False | 0 | OK |
| locked-impossible | fail | discretized_search_infeasible | - | 0 | - | - | 0.003 | 0 | True | False | 0 | OK |
| narrow-corridor | fail | discretized_search_infeasible | - | 0 | - | - | 0.018 | 0 | False | False | 0 | OK |
| wide-corridor | pass | solutions_found | pass | 1 | 0 | 390.0 | 1.55 | 97 | False | False | 0 | OK |
| impossible-turn | fail | discretized_search_infeasible | - | 0 | - | - | 0.008 | 0 | False | False | 0 | OK |
| unconfirmed-input | fail | needs_input | - | 0 | - | - | 0.002 | 0 | False | False | 0 | OK |
| procedural-1 | fail | solutions_found | pass | 1 | 1 | 95.0 | 0.459 | 102 | False | False | 0 | OK |
| procedural-2 | fail | solutions_found | pass | 2 | 3 | 95.5 | 10.0 | 488 | False | True | 0 | OK |
| procedural-3 | fail | solutions_found | pass | 2 | 2 | 14.1 | 0.626 | 140 | False | False | 0 | OK |
| procedural-4 | fail | solutions_found | pass | 2 | 2 | 145.0 | 10.0 | 173 | False | True | 0 | OK |
| procedural-5 | pass | solutions_found | pass | 1 | 0 | 110.1 | 10.019 | 534 | False | True | 0 | OK |
| procedural-6 | fail | discretized_search_infeasible | - | 0 | - | - | 0.001 | 0 | False | False | 0 | OK |
| procedural-7 | fail | discretized_search_infeasible | - | 0 | - | - | 0.002 | 0 | False | False | 0 | OK |
| procedural-8 | fail | solutions_found | pass | 2 | 1 | 140.0 | 0.83 | 85 | False | False | 0 | OK |
| procedural-9 | pass | solutions_found | pass | 2 | 0 | 356.5 | 6.364 | 141 | False | False | 0 | OK |
| procedural-10 | fail | solutions_found | pass | 2 | 1 | 90.0 | 0.525 | 51 | False | False | 0 | OK |
| procedural-11 | fail | solutions_found | pass | 2 | 1 | 89.3 | 0.939 | 66 | False | False | 0 | OK |
| procedural-12 | fail | solutions_found | pass | 2 | 1 | 180.7 | 5.703 | 758 | False | False | 0 | OK |
| procedural-13 | pass | solutions_found | pass | 1 | 0 | 77.6 | 10.004 | 933 | False | True | 0 | OK |
| procedural-14 | fail | discretized_search_infeasible | - | 0 | - | - | 0.001 | 0 | False | False | 0 | OK |

- Rooms: 21 (7 named fixtures, 14 procedural seeds).
- Verification mismatches: **0**. Every reported layout was re-analysed and its containment, overlaps, locked pieces and route clearance/start/end were re-checked independently.
- `solutions_found`: 14/21. This includes rooms that already passed.
- Grid misses (polygon connected, no grid path, flagged with a finer-grid warning): 0.
- Reproducibility: a second run gave identical results in the columns `fixture`, `before`, `search_status`, `after`, `moved_objects`, `route_length_cm`.

Column notes: `validated` is how many candidate layouts reached the full validator. `exhaustive` means every discrete combination was visited. Rows with `hit_time_limit` depend on machine speed and may differ between runs.
