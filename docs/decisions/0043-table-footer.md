# 0043 Table footer: Add new and Calculate

Status: accepted

## Decision

The Loads table gets a footer with an "Add new" row (opens the same new-load form as the New load button) and a Calculate picker under every visible column, with aggregations that fit its type: Freight and Documents get Sum, Average, Min, Max; Next appointment gets Earliest, Latest, Filled, Empty; Created gets Earliest, Latest; Carrier and Driver get Filled, Empty, Unique; Stage gets Unique. Documents figures read as accepted out of required (the average has one decimal, half up). Freight is summed as integer minor units in BigInt; the average rounds half up. Figures cover the loads currently shown, and the footer says how many that is.

## Consequences

The calculation choice is per page visit and is not saved in a view, so no schema or API change; rollback is reverting the commit. Still open: field reordering and a date-range query for the calendar.

## Toolbar (follow-up)

Filter (status, carrier), Sort (table only: field and direction) and Options now sit together on one right-aligned row of the view bar. Filter reuses the existing queue and carrier filters; Sort edits the same saved-view sort setting as the column headers. The inbox filter rail is narrower (140px, 120px on mid-size screens).
