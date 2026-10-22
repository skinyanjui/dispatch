# 0043 Table footer: Add new and Calculate

Status: accepted

## Decision
The Loads table gets a footer with an "Add new" row (opens the same new-load form as the New load button) and a Calculate picker on Freight (Sum, Average, Min, Max). Freight is summed as integer minor units in BigInt; the average rounds half up. Figures cover the loads currently shown, and the footer says how many that is.

## Consequences
The calculation choice is per page visit and is not saved in a view, so no schema or API change; rollback is reverting the commit. Still open: aggregations on other columns, field reordering and a date-range query for the calendar.

## Toolbar (follow-up)
Filter (status, carrier), Sort (table only: field and direction) and Options now sit together on one right-aligned row of the view bar. Filter reuses the existing queue and carrier filters; Sort edits the same saved-view sort setting as the column headers. The inbox filter rail is narrower (140px, 120px on mid-size screens).
