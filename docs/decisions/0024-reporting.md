# 0024 — Reporting

Status: accepted, 2026-10-21.

## Decision

A **Reports** page (dispatchers and carrier managers) and a loads CSV export, both read-only views over existing records. Nothing is copied or cached, so a report cannot disagree with the load, exception, document or billing screens it summarises.

**Scope.** Loads whose first pickup window starts in a UTC date range (default last 30 days, at most 366), optionally one carrier. Only carriers where the caller is a dispatcher or carrier manager are included; a carrier outside that set is `NOT_FOUND`; drivers have no reports. Dispatch-service invoice figures appear only for carriers the caller dispatches; carrier managers see their carrier's freight-billing figures only.

**Figures.** Load counts by stage and cancelled; freight value (agreed rates, cancelled excluded); on-time pickups and deliveries; exceptions by type (opened, open now, overdue, average hours to resolve); delivered loads with no accepted POD; per-carrier table; loads per pickup week; Relay dispatch invoices issued/paid/outstanding/overdue and carrier freight billed/received/outstanding.

**Honesty rules.**

- _On time_ counts only stops with a reported arrival whose current (non-superseded) report is no later than the window end. Stops past their window with no report are shown as "not reported", never counted on time or late, because arrivals are manual (ADR 0014).
- Money is summed in PostgreSQL as bigint minor units and sent as text; the browser formats it without floating point. Carrier freight "outstanding" is what carriers reported; Relay holds no freight funds (ADR 0009).
- Dates are UTC; the page says so.

**CSV.** Up to 5,000 loads, with an `X-Relay-Truncated` header beyond that. Cells starting with `= + - @` or control characters are prefixed with `'` so spreadsheets do not run them as formulas; quotes are doubled. Every export is audited.

## Not included

Charts beyond the weekly bars, saved reports, scheduled email reports, driver or lane profitability (no cost data exists), and per-timezone date boundaries.

## Rollback

No schema change. Remove the page and routes.
