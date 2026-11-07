# Admin dashboard

The dashboard is where you manage Otari in the browser: on otari.ai, sign in at
[otari.ai](https://otari.ai); a self-hosted gateway serves it at its root. It
uses the same management API available to scripts, so access and behavior are
determined by the server rather than duplicated in the frontend.

The dashboard reads `GET /api/v1/bootstrap` before rendering. That response
controls the available sign-in methods and navigation surfaces, so a page the
gateway does not serve is not offered.

If the gateway does not answer that request (it is down, restarting, or too slow
to answer within 8 seconds), the dashboard does not guess a mode. It says the
gateway is unreachable, keeps retrying in the background with a growing wait of
up to 30 seconds, retries at once when the browser comes back online or the tab
is shown again, and offers a Retry button. It opens as soon as an attempt
answers, with no reload. A refusal such as a 404 is not retried on its own; use
Retry once the address is fixed.

What a self-hosted gateway's operator sets up and sees, including the master
key, the first run and the deployment view, is in
[Run the dashboard](run-the-dashboard.md).

## Signing in

Password sign-in works for an existing account. Passkeys and Google or GitHub
sign-in add more ways to sign in where they are set up, and where signup is open
a new address can also create an account with its own organization, through the
signup form or a Google or GitHub sign-in. Where terms of service are
published, signup asks you to accept them first. How each method works is in
[Sign-in and accounts](sign-in.md).

A link to a dashboard page opened while signed out shows the sign-in screen
first, then that page once you have signed in, whichever method you use.

Signing in can also add a membership, where an organization has proven the
email domain of the identity's verified address; see
[Email-domain auto-join](members.md#email-domain-auto-join).

Account settings also carries the name you are known by, which is not a
credential: it is what the account menu, the organization roster and the user
column on the Overview shows. Someone an admin added to the roster by
address has no name until they set one here. Clearing it puts those surfaces
back to naming you by your sign-in address. The dashboard reads who is signed in
from `GET /api/v1/auth/profile`, which answers whether or not you belong to an
organization, so the account menu names you even before you join one.

## The setup guide

Overview offers a short setup flow until the selected workspace serves its first
successful gateway request from outside the product. A message sent in the
Playground does not close it: the guide marks the moment somebody's own code
first reached the gateway, which is the point of the flow. The key it creates is
an ordinary workspace API key.
Skipping the guide hides it for that workspace; it does not revoke a key already
created. A self-hosted gateway can turn the flow off; see
[The setup guide](run-the-dashboard.md#the-setup-guide).

## Navigation

Exact page names and availability can change with configuration and installed
extensions. The running dashboard is the source of truth.

The workspace view contains day-to-day gateway operations:

| Page | What it is | Rules |
| --- | --- | --- |
| Overview | The landing page: the month's spend, budget and failures, what needs attention, and the [setup guide](#the-setup-guide) | [The Overview](#the-overview) |
| Activity | The per-request log | [Activity and Usage](#activity-and-usage) |
| Usage | Aggregates and time series, for you, the workspace or the organization | [Activity and Usage](#activity-and-usage) |
| Playground | In-product chat and comparisons | [Playground](#playground) |
| Models | The catalog grouped by model | [Models and Routing](#models-and-routing), [Models](models.md#the-catalog-grouped-by-model) |
| Routing | Routing policies, aliases and Automatic fallback | [Models and Routing](#models-and-routing), [Routing](routing.md) |
| Tools | Built-in tools, MCP servers and guardrails for the workspace | [Built-in tools](tools.md) |
| API keys | Workspace API keys | [API keys](api-keys.md) |
| Members | Workspace members | [Members and invitations](members.md) |

The organization view contains tenant-wide administration:

| Page | What it is | Rules |
| --- | --- | --- |
| Workspaces, Members | Workspaces and organization members, with invitations | [Organization](#organization) |
| Email domains | Domains whose colleagues join automatically | [Email-domain auto-join](members.md#email-domain-auto-join) |
| Spend and budgets | Budgets and the spend ceilings holding them | [Budgets](budgets.md) |
| Providers > Inference (under General) | The organization's own provider keys, the models each one offers, and what the organization pays for them | [Organization provider keys](hosted-providers.md#organization-provider-keys), [Who is shown which models](models.md#who-is-shown-which-models) |
| Providers > Web search (under General) | The organization's own search and fetch keys | [Web search keys](#web-search-keys) |
| Guardrails, Org settings (under General) | Organization guardrail policy and settings | [Guardrails](guardrails.md) |

A self-hosted gateway's operator also has a deployment view, opened from the
account menu; see [The deployment view](run-the-dashboard.md#the-deployment-view).

Providers answers to the organization role rather than to deployment authority:
its owners and admins manage the keys, the models each key offers, and the rate each model is billed
at. Which rate applies is in [Pricing](hosted-providers.md#pricing).

### Web search keys

Providers > Web search is the organization's own search and fetch keys, in one
table per kind. Adding a key asks for its provider first, from the providers the
search and fetch libraries serve, and then for what that provider needs: a
name, the API key, and under More settings an endpoint of its own and the
provider's options. Editing a key never shows its secret; moving it to
another endpoint needs the API key entered again. The star on a key sets it
as the workspace default, the key every workspace uses unless it pins
another, and clicking a filled star unsets it. A
workspace uses the key its owners or admins pinned, otherwise the starred
key, otherwise the deployment's own search or fetch tool, so a key added and
not starred changes nothing until a workspace pins it. Archiving a key takes
it out of use, and an archived key can be restored or deleted. A key this
deployment cannot decrypt is marked unreadable. The page sets no prices: the
deployment's operator prices an organization's search and fetch calls.

### What a page shows depends on who is signed in

What a page shows can depend on who is signed in, not only on the deployment:

- **Spend and budgets.** An organization owner or admin manages their own
  organization's budgets and the spend ceilings holding them, while a deployment
  operator gets the deployment's own budgets, their active organization's, and
  the gateway users assigned to them.
- **API keys.** An operator manages every key in the organization and chooses
  each key's owner, while a member sees the same page scoped to their own keys,
  always billed to themselves and never budget-exempt. An operator, or an
  organization owner or admin, can also cap a key's own spend: the key's create
  and edit forms take an existing budget or a custom amount and reset, and a
  Budget column shows each key's spend this period against its limit. A key's
  Edit reports the routing its requests got, and its Set up routing, like the
  step after creating a key, opens the new-policy page for that key, starting on
  the model it sends most where that is a `provider:model`. For an operator it
  opens the Routing list, with the create dialog on that model when there is
  one. An organization owner or admin also manages every member's key. Where the
  deployment turns on `federation_member_rules`, a key's actions menu offers
  Workload identity… to the operator, and to an organization owner or admin on
  their own keys; see
  [Rules on a member's own key](workload-identity.md#rules-on-a-members-own-key).
- **The Overview, Activity, Usage and Routing** show an operator their active
  organization, not every organization on the deployment.

## Models and Routing

Models is the catalog grouped by model: one card per model, with a rail of
filters beside it, and a page per model with its facts and every offering
compared in a table, each with its own limits and the price your organization
is charged. Each row shows the provider's own model ID under the provider, which
tells apart two offerings on one provider, such as Bedrock's regional inference
profiles. "Use this model" opens a drawer beside the table with the request to
copy, sent to the gateway's pick or to a provider pinned by its selector. The
page is read-only; an organization's own rate is set on Providers > Inference, which an
offering on one of that organization's keys links to. An offering the
deployment supplies the credential for says so instead, because its rate is the
deployment price list's rather than a tenant's. What the page requests is in [Browsing the grouped catalog](models.md#browsing-the-grouped-catalog).

Routing lists each policy with its models in the order tried, who it applies
to, which keys sent it and how many requests in the last 30 days, and a key
filter narrows the list to what one key sent. A member sees their own policies
apart from the shared ones, and can make their own version of a shared one where
the workspace allows it. Create policy opens a new-policy page in an
organization's workspace, with the policy's name and who it applies to on top;
for a deployment operator it is a dialog that first asks what the policy is for.
Each policy has its own page, opened from Edit in the list: one form holding its
main selection, its models in the order tried, rules, budget tier-down and
guardrails, saved together from one Save. An alias opens to the model it points
to, and an owner or admin can turn it into a policy of the same name. Models are
chosen by model and then by provider. How to create and edit a policy
there is in [Failover](routing.md#failover).

Routing's **Automatic fallback** section, read from
`GET /api/v1/organizations/me/automatic-fallbacks`, lists every model your
organization sent requests to in the last 30 days, most requested first, by
catalog id (see [Catalog spellings](models.md#catalog-spellings)). Each row
shows its requests (an absorbed attempt is not one), the share of them that
sent the catalog id and so could fall back, and its providers in the order such
a request tries them for your organization, each at the input price that order
ranks by. That order is the baseline; automatic routing can reorder it per
request. The share is a dash for a model one provider serves, and is flagged
below half. A row with requests that named a provider or a routing policy opens
on the API keys that sent them, with the provider each reached; a policy's own
fallback still applied to the ones that named a policy. The order is the
catalog's, before a key's allow-list or a missing credential leaves an offering
out of a request's plan. Requests from before a deployment recorded the catalog
id they sent count as having named one. An owner or admin reads every
workspace in the organization, anyone else the workspaces they belong to. The
response also says who runs the built-in tools on each offering (`own_tools`,
`otari_tools`), for a caller that declares them in the provider's own words and
sends no `Otari-*` executor header.

## Entering a rate

A rate is per million tokens, per request, or per image, and the rate form asks
which. A request or image rate is entered per 1,000, the way providers publish
one: $2 per 1,000 searches for a rerank model is entered as 2 and stored as 2000
per million, which is how every rate travels on the wire. The model lists name
such a rate by its unit, for example "$0.002 per request". The same choice is on
the Requests view's "Price this model", offered on a served request that carried no cost
(a failed attempt billed nothing, so its error is the guide instead), which
opens per request for a rerank, audio or moderation request and per image for
an image generation or edit. What each unit bills is in
[Each endpoint in its unit](configuration.md#each-endpoint-in-its-unit).

## Playground

The Playground is the in-product chat page: pick a model the gateway serves and
talk to it, or put two side by side and record which answered better. Requests
run through the same path as any other completion, so routing policies,
guardrails, budgets and the tool loop all apply, and every request appears on
the Overview.

A question can carry files. Attach them with the paperclip in the composer or
drop them anywhere on the page; each uploads at once and shows as a chip with
its name and size until the question is sent. The model reads them the way an
API request's [uploaded files](files.md) are read, so a text-only local model is
given their extracted text. When comparing, both models get the same files. A
saved conversation remembers which files each question carried. Removing a
chip takes the file off that question and keeps the upload: the Files dialog
lists everything you uploaded in the workspace, to attach again or to delete.
These controls do not appear when file uploads are off.

The Tools menu attaches web search, code execution and any number of MCP
servers to the next message, in any mix: the model is offered all of them in one
tool loop. A tool the gateway runs shows in the transcript above the reply as a
collapsed row with its status, opening to the arguments the model sent and what
the tool returned (a long result is shortened for display). This activity is
shown in the Playground only and is not saved with a conversation; a request
made through the API still returns just the final message, as
[What clients receive](tools.md#what-clients-receive) describes.

Two things are worth knowing about how it is billed and what it stores.

A Playground request carries no API key. It is authorized by the dashboard
session and billed to whoever sent it, in the workspace the switcher has
selected, against that person's own budget and rate limit; its usage row
therefore has no key attached. A viewer cannot send one, since it spends like a
key, so the page tells them so instead of offering a composer. Picking a different model changes which provider
credential the gateway resolves, never who pays. A request made here also does
not count as the workspace's first request, so the setup guide keeps waiting for
one from outside the product, which is the milestone it exists to mark.

Nothing is stored until asked for. Saving a conversation or recording a
comparison prompts once for content retention, and the flags are per person and
revocable; withdrawing one blocks new saves and deletes nothing. Saved
transcripts, recorded comparisons and pinned models are visible only to the
person who created them, even to colleagues in the same workspace, and each can
be deleted from the page.

## Observability

### The Overview

The Overview is the landing page. It reads one calendar month in UTC, this one
unless the month menu picks one of the eleven before it (any other range is
Usage's), and one scope: a member sees their own usage, while someone who
manages the workspace switches between the Workspace, You and, if they manage
the organization, the whole Organization. A line at the top names what needs
acting on now, as the gateway judges it for your role (a provider down, a key or
budget near its limit or on pace to pass it, a key about to expire), each
linking where it is fixed. Three numbers follow: the total at API prices, split
into billed and subscription and set against the same days of the month before
(a past month against the whole month before); the workspace budget, or across
the organization the tightest spend ceiling, with its pace; and requests, with
how many failed. Under them, the month's running
total of billed spend against the budget, projected to the month's end at its
pace so far (the Budget tile's pace, and the gateway's crossing date, once the
month is a day or a tenth in, whichever is longer), then the month's latest
failures, each opening in Activity.
Beside them sit the limits that apply in the scope: your keys, the workspace's
keys, or the organization's workspaces against their ceilings. A deployment
operator also sees whether each provider answers. The scope and month live in
the URL.

Whether members see workspace totals is a per-workspace setting its managers
change on the Members page, and it starts off. While it is on, a member switches
between You and Workspace. At You, their chart stacks their own spend under the
rest of the workspace's against the budget line and its projection, as a
manager's does, and the Budget tile adds their share. At Workspace, the tiles
and the chart are the workspace's, but the limits rail lists no keys, since the
workspace's keys are other people's, and says to switch to You for their own.
The failures listed there stay the member's own, titled "Your recent failures"
and counted from their own requests, because a member reads no one else's
requests; the Requests tile still counts the workspace's failures, without a
link, since Activity would show only theirs. What needs attention names the
workspace budget and the member's own keys only. While the setting is off, a
member reads only their own usage, so their chart is their own running total
alone, with no budget line or projection: their share cannot show how close the
workspace is to its budget, and the caption says the totals are hidden by an
admin. The Budget tile then gives the workspace budget for the month running as
a whole percent of its cap ("used of $1,000"), without the dollars spent; with
no budget set it shows their own billed spend as before. Where the setting
cannot be read (the overview failed), a member sees their own spend, as if
hidden, and where a read of the workspace's totals is refused because the
setting changed meanwhile, the page reads it again and follows it. A month
that has ended is drawn against today's budget and today's limits, since past
ones are not stored, so it carries no verdict: no crossing date, no severity,
and limits named ("Limit today") rather than measured against the month.

Before anything has been sent, Overview opens with a getting-started strip. A
deployment operator sees it on a gateway with no providers and no usage, with a
link to add the first provider. Anyone else sees it while the model catalog is
empty and their account has made no requests: an organization owner or admin is
linked to add a provider key, and a member, who cannot add one, is told to ask
an owner or admin. Once a model is available the strip goes and the setup guide
takes over.

### Activity and Usage

Activity is the per-request log. Usage provides aggregates and time series.

Whose requests they show follows workspace management. In a workspace you
manage, as an owner or admin of the organization or of that workspace itself,
you see everyone's requests and can narrow to your own; in any other workspace
you belong to, you see only your own. Managing one workspace widens that
workspace and no other. While a workspace shares its totals with members (off
until a manager turns it on), the organization usage API also gives a member its
aggregates when asked (`workspace_totals=true`): totals, the time series and the
95th percentile latency, split by model, provider or status code, never another
person's requests, keys or sessions, nor the gateway-run tools. See
[Access control](access-control.md#workspace-scoped-spend).

Filter Activity from the log itself: each column header sorts and holds that
column's filters, a cell in any of the value columns can narrow the log to its
value or exclude it, and the search box matches a request ID, a model, the name
the caller sent, a key, a session or a member. Drag across the chart, or click a
bar, to narrow to a stretch of time. The log can be grouped by API key, session,
model or member. Everything about a view lives in its URL, so a link reproduces
it, and a view can be saved by name; someone who manages the workspace can share
one with it.

Usage answers where usage is going over time. Pick whose usage (You, the
Workspace if you manage it or its managers share its totals with members, or the
whole Organization if you manage that) and a window from a day to a year.
Three numbers lead: the total at API prices, split into what was billed and
counts toward limits and what a subscription covered,
which is tracked but billed nothing; requests, with how many failed; and tokens,
with how much came from cache. Each compares with the window before it. One
choice of breakdown (model, API key, session, channel, provider, policy, member
at Workspace scope, workspace at Organization scope) drives both the stacked
chart and the table under it, and the table sorts by any column, its 95th
percentile latency included. The gateway does the sorting, so on a breakdown
with more groups than the table lists, the rows kept are the top of that
column rather than of the share. A row's cell narrows the page to its value or
leaves it out, dragging across the chart narrows it to a stretch of dates, and
clicking a row opens its requests in Activity with the same filters and window;
from Organization scope Activity opens on that row's workspace. A member at
Workspace scope reads the workspace's totals: the breakdowns are model and
provider only, the gateway-run tools are not listed, no filter naming a person,
key, session, channel or policy is sent (one already in the URL waits there,
marked as not in this scope), and rows do not open in Activity, which shows a
member only their own requests. While the
workspace keeps its totals from members, a member's Usage is You only, and the
workspace budget beside the window reads as a percent "used of" its cap, with a
line saying the total is hidden by an admin. A link to Workspace scope waits for
the setting before it reads anything, rather than showing a member their own
usage first. The organization's usage is that Organization scope rather than a
page of the organization view. Everything lives in the URL under the names Activity reads (`model`, `api_key_id`, `user_id` and
the rest), and a view can be saved by name, as on Activity. A key's actions menu
on the API keys page has View usage, which opens Usage filtered to that key.

A routed request is one row, served by whichever attempt succeeded; its earlier
failed attempts are counted on it and listed under it on request. A stream the
client abandoned is marked Incomplete, at its estimated cost, and the status
filter picks or leaves those out like Succeeded, Failed and Recovered. Opening a row
shows the request beside the log: its routing plan, source, token composition,
cost and timing. Live updates bring the log up to now every ten seconds, and the
totals, latency, chart and a grouped log every minute. They hold still while you
page back, read a request, or look at a window that has ended.
Imported usage is labeled by source, shown at its equivalent cost, and does not
consume a budget. Everyone in a workspace sees what it has spent against its own
ceiling, where it has one.

A deployment operator also sees what is in flight, can set a model's price from
a request that had none, and can recost or delete the imported rows the filters
match. On a phone the log is a list, with sort and filters in one sheet.

Use Prometheus at `/metrics` for process-level monitoring when
`enable_metrics` is enabled. The scrape needs the `metrics` extra
(`pip install gateway[metrics]`); the Docker image installs it, and a
source install that sets `enable_metrics` without it refuses to start rather
than serving an empty scrape.

## Organization

Organizations own workspaces. The workspace switcher determines which keys,
members, usage, tools, aliases, and stored routing policies are in view. The
organization section manages resources shared across those workspaces.

The Members page lists the selected workspace's roster. For someone who manages
the workspace it also holds Workspace visibility: one switch, Workspace totals,
that decides whether members see the workspace's spend, budget used and request
counts on Overview and Usage, and a list of what a member will see with it on or
off. A member always sees their own requests and usage, and never anyone else's
individual requests. Members do not see the section.

What a signed-in person can see or change is enforced by their organization and
workspace roles. Deployment-wide operations require an operator. See
[Access control](access-control.md).

Invitations waiting on you are listed under Invitations, reached from the
organization switcher. After you accept one, the page offers to take you into
that organization. Someone signed in who is not yet a member of any
organization is taken to Invitations when one is waiting; otherwise Overview
says how to get in, and the sidebar holds only Overview. Creating an
organization is offered to them only where signup is open, since the gateway
refuses it otherwise.

Opening an invitation link in a browser signed in as a different address, or as
an identity with no address, says who the invitation is for and offers to sign
out and continue, because accepting always adds the invited address, whoever is
signed in. After a
password is set from an invitation link, the sign-in screen opens with the
invited address filled in. When the link cannot set a password and the address
has none yet, the page says how to get in instead: a Google or GitHub sign-in,
or "Forgot your password?", whichever the deployment offers. The other pages in
front of sign-in carry the address the same way: from the sign-in screen to
"Forgot your password?", from signup or a resend to the page saying which
address was mailed and on to another resend, and back to the sign-in screen
after a verification or a recovery request. A password never travels with it.

On Members, an invited row offers Reissue and Revoke; see
[Manage existing members](members.md#manage-existing-members). When an
invitation email does not go out, you get the accept link to share; see
[Invitations](members.md#invitations). For an account that already exists, an operator
can generate a password instead: **Accounts**, then **Set password**, shows it
once to hand over.
