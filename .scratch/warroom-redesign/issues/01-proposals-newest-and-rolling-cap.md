Status: resolved

# War Room: Proposals newest first, cap labelled as a rolling 24 h count

A saturated cap ("30 of 30") looks stuck because it says "today"/"a day" while it is a rolling 24 h window, and the list sorts by score so new Proposals sit out of sight.

Operator approved two changes, nothing more:

- [x] The Proposals cap indicator says "N of 30 in the last 24 h" on the home page research panel and on /activity.
- [x] The Proposals list defaults to newest first. The War Room page sends `sort=newest` itself; the shared datastore and `/api/proposals` default stay score, and the Score sort stays in the Sort control.

Out of scope: the datastore default, the "Usage today" heading on /activity.
