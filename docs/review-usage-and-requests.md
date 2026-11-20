# Review usage and requests

**Home**, the page the dashboard opens on, shows what a time window cost and
where the spend went. The per-request log is the **Requests** view of
**Sessions**, beside its list of agent sessions (see [Sessions](sessions.md)).

## Home

Pick the window at the top: **Today**, **Yesterday**, **7D**, **30D**, **3M** or
**6M**; Home opens on **30D**. Days are your browser's calendar days. **Today**
runs from midnight to now and **Yesterday** is the whole day before it, both
read by the hour; the others are whole days ending with today. On a phone the
same windows are in a select. **Refresh**, beside the window, reads every
figure again, and the time beside it says when they were last read. What Home
shows depends on your role.

An organization owner or admin sees the whole organization, or one workspace
picked beside the window when there is more than one.

**Needs attention** comes first, over the last 24 hours whatever the window.
Each line says what is wrong and ends with the link or dialog that fixes it:

- a spend limit that is reached, at 80% or more, or on pace to run out before it
  resets (**Raise the limit**);
- requests the gateway refused, and failures at 2% or more of a workspace's
  requests (**See the refusals**, **See the failures**). Each is counted per
  workspace, and its link opens **Requests** on that workspace;
- an API key in use that expires within 7 days (**Open in API keys**);
- for the deployment operator, a provider the gateway cannot reach
  (**Check the provider**).

With nothing to act on it says so in one line. The figures follow:

- What the window cost, against the same span before it (**Today** against
  yesterday up to the same time of day), with spend per hour or per day. When
  part of it never counted toward a budget (an API key marked exempt from
  budget, or imported usage), the line under it splits it
  (**$30.00 charged · $20.00 not charged**), and a window longer than today
  adds what was spent today.
- How much of the organization's spend limit is used, and what the period is on
  pace to cost. With no limit set, **Set a team budget** sets one.
- **Failures**: the share of requests that failed, judged **Healthy**,
  **Elevated** (2% or more, and at least five failures) or **High** (10% or
  more). **N failed** and **N unpriced** open those requests in **Requests**.
- Billed tokens, and how much of the input was read from cache.
- **People active**: how many members spent anything in the window, and how
  many sessions ran. **See the sessions** opens them.

**Where it went** then breaks the window's spend down by **People**,
**API keys**, **Models**, **Providers** or **Workspaces** (offered when there is
more than one workspace). Each row shows what it spent, its tokens and its share
of the total; outside **Models**, it also shows its top model, and outside
**Models** and **Providers** the spend limit it works under, with a meter and
when the limit resets. A key's row also says when it was last used, and warns
when it expires within 7 days. The five largest
rows show first, and **Show all** lists the rest. A person's name opens their
page (see [One person's spend](#one-persons-spend)). At the end of each row,
**Sessions** opens its sessions over the same window, **Requests** a provider's
requests, and **People** narrows the table to that workspace's people. A row's
menu sets or changes its spend limit, and a key's row can be opened in
**API keys**.

**Recent failures** lists the window's latest failed requests: when, the
model, the key and the error. Each one opens that request in **Requests**, and
**See all** opens every failure of the window.

**Providers** names the provider each request went to, or the instance an
operator named, which is the figure to match against each provider's own bill
when your organization brings its own provider keys. Requests that recorded no
provider, such as imported usage that did not name one or requests refused
before a provider was picked, share one **Unknown provider** row, so the rows
still add up to the total.

Anyone else sees only their own requests in the selected workspace: what they
spent (split into charged and not charged as above), the spend limit on them
there, their tokens and their sessions. Their **Needs attention** lists their
own refused and failed requests of the last 24 hours and their own keys that
expire within the week, and **Recent failures** lists their own failed
requests.
**Where it went** breaks their spend down by **API keys**, **Models** or
**Providers**, and each row ends with **Sessions**, or **Requests** for a
provider, which opens what it ran.
Someone with no active key and no session yet is offered
**Create API key**; someone who may not create keys is told whom to ask.

### Get started

On a gateway with nothing to route to and nothing served yet, Home opens with
**Get started with Otari**. The operator is offered **Add your first provider**,
an organization owner or admin **Add a provider key**, and anyone else is told
to ask an owner or admin.

## One person's spend

Open **People** and pick a person, or press a person's name in Home's
**Where it went**, to see where their spend went. Pick the
window above the figures: **This month**, the page's default, or **Today**,
**7D**, **30D**, **3M** or **6M**, as on Home. The figures, the breakdown and
their sessions all follow it, and the window is kept in the URL.

**Charged** is what counts toward their budgets. Spend through an API key marked
exempt from budget, such as a key that records a Claude Code subscription's
usage, and imported usage are tracked but not charged; when there is any, the
figure's line says how much (**+$40.00 not charged**). The two add up to the
**Spent** figure Home shows for them, which counts both.

**Where it went** breaks their spend down by **Models**, **API keys**,
**Providers** or **Sources**, the costliest first. Each row shows its requests,
tokens and spend; once any of the window's spend is exempt, the spend is shown
in two columns, **Budgeted** and **Exempt**. A key exempt from budget is marked
**Exempt from budget**. Each row ends with **Sessions** (models and keys) or
**Requests** (providers and sources), which opens what they ran on it over the
same window.

## Requests

Open **Sessions** and pick **Requests** for the per-request log. The two views
share one time range and the model, user, API key and status filters, which
stay in place when you switch views and are kept in the URL.

Filter from a column's header: each filterable column has a funnel that opens
its values with how many requests carry each, busiest first, with a search box
when the list is long. Check a value to keep only its rows, or press the slash
beside it to leave it out. On Requests, **Model** also lists providers and,
once the window ran one, the gateway tool a request used; **API key** lists
the sources requests came from once there is more than one; **Routing** lists
routing policies and offers **Direct requests only**; the token, **Cost** and
**Total time** columns show only the rows above a threshold; and **Cost**
offers **Priced only** or **Unpriced only**. The funnel takes the accent color
while its column is filtered. Every filter, including one a link set (a
session, a status code, an endpoint), is a chip in the one row above the table
that removes it; **Clear all** removes them together.

On a phone the table is a list of cards with no headers, so the row above it
has a **Filters** button instead, with a count of the filters applied. It opens
a sheet with one section per filterable column, in the table's order, each
holding what that column's funnel holds. Expand a section to load its values;
changes apply as you make them. **Done** closes the sheet and **Clear all**
removes every filter.

On a desktop, drag the edge of a column's header to resize it, and use
**Columns** at the end of the filter row to hide or show columns; the column
that names each row (**Model** on Requests, **Name** on Sessions) is always
shown. A filter on a hidden column stays in the chip row and still applies.
**Reset columns** returns the widths and the columns to the defaults. The
layout is saved to your account, per view, so it follows you to another browser
or device. Phones show every field on the cards.

**Status** narrows Requests, and Sessions for errors and successes. Exclusions,
**Provider**, tool, source, pricing, routing and thresholds narrow Requests only, so they stay behind
when you switch to Sessions. On Requests, dragging across the chart narrows the
range. Both views show everyone's requests in the workspace; pick yourself in
the **User** column's filter to see only yours.

## Find one request

To find one request, open `/requests?request=<id>` with the `Otari-Request-ID`
its response carried. Routed requests share a request group, so the log shows
each model tried and the one that served the response. Imported usage is labeled
by its source and does not use a budget (see
[Import usage from outside Otari](external-usage.md)).
