# KPI definitions

Every figure below is computed in Postgres (never in the browser) and stored on the row it belongs to. Ratios are kept to 4 decimals (0.8750 = 87.50 %).

## Injection moulding (per shift entry, `prod.injection_shifts`, `api.record_injection_shift`)

| Figure | Definition |
|---|---|
| Planned production time | `planned_minutes`, entered for the shift (shift length minus planned breaks). |
| Downtime | Sum of the shift's downtime rows (`prod.downtime`): setup, mould change, breakdown, no material, no operator, power, quality, other. |
| Run time | `run_minutes = planned_minutes − downtime_minutes`. |
| Standard cycle time | The mould's `cycle_time_sec` at the time of the entry (copied onto the shift). |
| Theoretical output | `floor(run_minutes × 60 ÷ cycle_time_sec) × cavities_running` (whole shots × cavities in use). |
| Total output | `good_qty + reject_qty` (rejects = sum of `prod.shift_rejects`). |
| Shots | `shot_end − shot_start` from the counter; if not entered, `ceil(total output ÷ cavities_running)`. Added to the mould's shot count. |
| Availability | `run_minutes ÷ planned_minutes`, rounded to 4 decimals. |
| Performance | `total output ÷ theoretical output`, rounded to 4 decimals; null when theoretical output is 0. Not capped: above 1 means the real cycle was faster than the standard (check the standard). |
| Quality | `good_qty ÷ total output`, rounded to 4 decimals; null when nothing was made. |
| OEE | `availability × performance × quality` (of the rounded factors shown on screen), rounded to 4 decimals. |

Tested in `supabase/tests/15_production_plastics.sql` (recomputed from the raw shift data).

## Biochem batches

| Figure | Definition |
|---|---|
| Packaging reconciliation (per item) | `issued = in good packs + in rejected packs + scrapped + returned + at the line`; difference must be exactly 0. In packs = Nos per pack (formula) × packs. |
| Bulk reconciliation | `bulk made (kg) − (good + rejected packs) × fill (g) ÷ 1000 − bulk scrapped − bulk left` within `bulk made × production.bulk_loss_pct ÷ 100`. Setting unset → must be exactly 0. Fill = the formula version's `fill_qty_g`, else the item's net quantity (GMS / KGS). |
| Batch cost | materials (weighted average at issue) + packaging (weighted average) + labour hours × `labour_hour` rate + machine hours × `machine_hour` rate + bulk kg × `overhead_per_kg` rate. Missing rates count as 0 and are listed in `rates_missing`. |
| Cost per pack | batch cost ÷ good packs. |

## Plastics costing

| Figure | Definition |
|---|---|
| Mould cost per shot | `(mould cost + services and repairs) ÷ life shots`; per piece ÷ cavities. |
| Component cost per piece | granule share `(part g + runner g ÷ cavities) ÷ 1000 × (1 − masterbatch %) × granule avg cost` + masterbatch share + packing per piece; mould cost per piece shown alongside. Scrap credit is zero until scrap carries a value (scrap is weighed in at cost 0; scrap sales carry the credit). |
| Cost per print | `(ink value + labour minutes ÷ 60 × labour_hour rate) ÷ (pieces printed × prints per piece)`. |
