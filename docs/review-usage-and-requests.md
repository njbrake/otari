# Review usage and requests

**Home**, the page the dashboard opens on, shows what a time window cost and
where the spend went. The per-request log is the **Requests** view of
**Sessions**, beside its list of agent sessions (see [Sessions](sessions.md)).

## Home

Pick the window at the top: **Today**, **Yesterday**, **7D**, **30D**, **3M** or
**6M**; Home opens on **30D**. Days are your browser's calendar days. **Today**
runs from midnight to now and **Yesterday** is the whole day before it, both
read by the hour; the others are whole days ending with today. On a phone the
same windows are in a select. What Home shows depends on your role.

An organization owner or admin sees the whole organization, or one workspace
picked beside the window when there is more than one:

- What the window cost, against the same span before it (**Today** against
  yesterday up to the same time of day), with spend per hour or per day.
- How much of the organization's spend limit is used, and what the period is on
  pace to cost. With no limit set, **Set a team budget** sets one.
- **Failures**: the share of requests that failed.
- Billed tokens, and how much of the input was read from cache.
- **People active**: how many members spent anything in the window, and how
  many sessions ran. **See the sessions** opens them.

**Where it went** then breaks the window's spend down by **People**,
**API keys**, **Models**, **Providers** or **Workspaces** (offered when there is
more than one workspace). Each row shows what it spent, its tokens and its share
of the total; outside **Models**, it also shows its top model, and outside
**Models** and **Providers** the spend limit it works under. The five largest
rows show first, and **Show all** lists the rest. A person's name opens their
page (see [One person's spend](#one-persons-spend)). At the end of each row,
**Sessions** opens its sessions over the same window, **Requests** a provider's
requests, and **People** narrows the table to that workspace's people. A row's
menu sets or changes its spend limit, and a key's row can be opened in
**API keys**.

**Providers** names the provider each request went to, or the instance an
operator named, which is the figure to match against each provider's own bill
when your organization brings its own provider keys. Requests that recorded no
provider, such as imported usage that did not name one or requests refused
before a provider was picked, share one **Unknown provider** row, so the rows
still add up to the total.

Anyone else sees only their own requests in the selected workspace: what they
spent, the spend limit on them there, their tokens and their sessions.
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

Press a column's header to sort the whole window by it. Names run A to Z
first; tokens, **Cost** and **Total time** run largest first, and **Status**
puts failures first. Press it again for the reverse order and a third time to
go back to newest first. **API key** sorts by the key's name, or the source of
a request no key made. The order is kept in the URL. A sort other than time
reads the last 30 days when the range has no start.

The search box in the filter row finds requests by request ID (pasted whole),
or by part of a user's name or ID, a model (the one that served or the
name the caller sent), an API key's name, a source or a session. It searches as
you stop typing, and every view of the page (the chart, the count and the
column filters' values) follows it.

On a phone the table is a list of cards with no headers, so the row above it
has a **Filters** button instead, with a count of the filters applied. It opens
a sheet with one section per filterable column, in the table's order, each
holding what that column's funnel holds, under a **Sort** section that orders
the cards. Expand a section to load its values; changes apply as you make them. **Done** closes the sheet and **Clear all**
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

Pressing a row opens it in a panel beside the log. Its header carries the
request ID with a copy control and where the request sits in the page (`3 /
25`); **K** and **J** step to the previous and next request. The panel shows:

- for a failed request, a banner naming the status in words and the stored
  error; a request the gateway refused under `require_pricing` says so, and an
  operator can price the model from it;
- for a routed request, every attempt in order, how many failed or were skipped
  before the one that served, and each failed attempt's error;
- **Requested as**, the name the caller sent and whether it was a model, an
  alias (with its target) or a routing policy, beside **Served by**, the
  `instance:model` that answered (**Target** on a request nothing served).
  Requests logged before Otari recorded the name, and batch results, show only
  the second;
- **Channel**: an API key, no key (the Playground or the master key), or an
  imported source's subscription, with a chip when the request does not count
  toward budgets;
- each gateway tool the request ran, with its calls, failures, rate and cost;
- the token mix as a bar with its cache-hit share, the cost (billed, or the
  equivalent cost of imported usage) split into model and tools, and whether it
  counts toward budgets;
- the time to the first streamed token, the total time and the provider's own
  compute time where it reports one.

The buttons along the bottom filter the log to the request's session, model or
gateway tool, and on a chat request **Open in Playground** opens the model
that served it.
