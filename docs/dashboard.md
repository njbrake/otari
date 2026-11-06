# Admin dashboard

Otari serves its dashboard at the gateway root. The dashboard uses the same
management API available to scripts, so access and behavior are determined by the
server rather than duplicated in the frontend.

The dashboard reads `GET /api/v1/bootstrap` before rendering. That response controls
the available sign-in methods and navigation surfaces, so a page the deployment
does not serve is not offered.

If the gateway does not answer that request (it is down, restarting, or too slow
to answer within 8 seconds), the dashboard does not guess a mode. It says the
gateway is unreachable, keeps retrying in the background with a growing wait of
up to 30 seconds, retries at once when the browser comes back online or the tab
is shown again, and offers a Retry button. It opens as soon as an attempt
answers, with no reload. A refusal such as a 404 is not retried on its own; use
Retry once the address is fixed.

## Sign-in and secrets

The master key and `OTARI_SECRET_KEY` are different credentials:

| Credential | Purpose |
| --- | --- |
| Master key | Authorizes deployment management and signs in the first operator |
| `OTARI_SECRET_KEY` | Encrypts provider and search-tool credentials stored in the database |

If `OTARI_MASTER_KEY` is unset on a new database, Otari generates a
master key and prints it once. The dashboard exchanges it for an HttpOnly session
cookie; it does not store the master key in browser storage.

Set `OTARI_SECRET_KEY` before saving provider or search-tool credentials through
the dashboard:

```bash
otari gen-secret-key
```

Keep this key separate from the database. Losing it makes stored credentials
undecryptable. Providers configured in `config.yml` do not require it.

The operator can claim a new deployment by setting an email address and password
from Account settings. After that, the sign-in page uses the password rather than
the master key. The master key remains valid for management API calls and can
reset the operator password. It resets the operator's password only: to help a
member who forgot theirs, send them a password link from Accounts, which emails
it where mail is configured and otherwise gives you the link to share (see
[Access control](access-control.md#deployment-wide-account-administration)).

The sign-in page offers the email and password form as soon as any identity holds
a password, which can be before the operator claims the deployment: a member
added to the roster and signed up signs in there. While both credentials still
work, the page offers the master-key box beside the form.

Account settings also carries the name you are known by, which is not a
credential: it is what the account menu, the organization roster and the user
column on Usage and Activity show. Someone an admin added to the roster by
address has no name until they set one here. Clearing it puts those surfaces
back to naming you by your sign-in address. The dashboard reads who is signed in
from `GET /api/v1/auth/profile`, which answers whether or not you belong to an
organization, so the account menu names you even before you join one.

## First-run walkthrough

1. Start Otari.
2. Open the gateway root, usually `http://localhost:8000/`.
3. Sign in with the configured or generated master key.
4. Add a provider. If storing its credential in the dashboard, configure
   `OTARI_SECRET_KEY` first.
5. Test the provider connection or declare model IDs for a backend that has no
   model-listing endpoint.
6. Create an API key from the setup guide or the Keys page.
7. Send a request and confirm it appears under Activity.

The [Quickstart](quickstart.md) includes a complete request example.

## The setup guide

Overview offers a short setup flow until the selected workspace serves its first
successful gateway request from outside the product. A message sent in the
Playground does not close it: the guide marks the moment somebody's own code
first reached the gateway, which is the point of the flow. The key it creates is
an ordinary workspace API key.
Skipping the guide hides it for that workspace; it does not revoke a key already
created. Set `activation_guide: false` to disable the flow for the deployment.

## Navigation

The workspace view contains day-to-day gateway operations:

- Overview, Activity, and Usage
- Playground, Models, and Routing. Models is the catalog grouped by model: a list of cards with a rail of filters beside it, and a page per model where every offering of it is compared, each with its own limits and the price your organization is charged. Each row shows the provider's own model ID under the provider, which tells apart two offerings on one provider, such as Bedrock's regional inference profiles. It is read-only; a rate is set on Providers. Routing lists each policy with its models in the order tried, who it applies to, which keys sent it and how many requests in the last 30 days, and a key filter narrows the list to what one key sent. A member sees their own policies apart from the shared ones, and can make their own version of a shared one where the workspace allows it. Automatic fallback lists the models your organization used in the last 30 days with the providers their catalog ID tries in order, how many requests a backup served, and which ones have no backup, including those most requests pin to one provider. The Models guide explains the order. Create policy opens a new-policy page in an organization's workspace, with the policy's name and who it applies to on top; for a deployment operator it is a dialog that first asks what the policy is for (a fallback, a traffic split, a smart router, spill-over at rate limits, or a budget tier-down). Models are chosen by model and then by provider. Each policy has its own page, opened from Edit in the list: one form holding its main selection, its models in the order tried, rules, budget tier-down and guardrails, saved together from one Save. An alias opens to the model it points to, and an owner or admin can turn it into a policy of the same name. Policies from `config.yml` open there read-only.
- Tools
- API keys and workspace members

The organization view contains tenant-wide administration:

- Workspaces and organization members
- Email domains, for joining colleagues automatically
- Spend and budgets
- General: Providers, followed by Guardrails and Org settings.
  Providers is the organization's own upstream credentials, the models each one
  reaches, and what this organization pays for them: adding a key offers every
  model the provider lists on it, each carrying a switch that decides whether
  the runtime serves it. Each is priced by the first rung that answers, which is
  the order a request is metered by: this organization's own rate, then the
  deployment price list, then the community defaults. A model nothing prices is
  offered and left unserved. Each key's row counts how many of its offered
  models are serving, and a key serving none of them is marked, because every
  request through it is refused until a switch is on. The star on a key makes
  it the organization's default for its provider, and clicking a filled star
  removes that. For a provider the deployment has no credential of its own
  for, a workspace uses the key it set to "Always use this key", otherwise the
  organization's default, otherwise the oldest key; a key it set to "Never use
  this key" is passed over at every step. The deployment's own provider
  credentials, served to every organization, are managed on Hosted providers
  in the deployment view, or in `config.yml`.

The deployment view, opened from the account menu, holds what belongs to the
gateway process rather than to any organization on it:

- Settings, the running configuration.
- Accounts, every account on the deployment.
- Hosted providers, the keys the deployment serves inference on for a request
  that brings no credential of its own. A request is served on one only after
  the organization's own keys and the configured providers have not answered.
  Adding a provider offers every model it lists on the key; each model carries a
  serving switch and a price, set per million tokens or per 1,000 requests or
  images, and a model nothing prices arrives switched off. Refresh models asks
  one provider again. Update catalog fetches the latest models.dev prices and
  then asks every provider what it lists, showing the price changes and each
  provider's new models before applying them; its optional cleanup also removes
  priced models nothing on the deployment serves, along with the model lists of
  providers nothing configures any more, listing them before anything is
  removed. A provider kept to one organization shows which; that restriction
  is set through `/api/v1/hosted-providers`. A provider defined in the
  `hosted_providers:` block of `config.yml` carries a `config.yml` badge and
  cannot be edited, switched or removed here, while its models can; adding a
  provider of the same name overrides it, which the form warns about.
  A provider takes an optional name, which defaults to its implementation; a
  name of its own (`openai-eu`) serves a second endpoint of one implementation,
  reached as `openai-eu:<model>`. The key is optional for a provider that needs
  none and for one pointed at an endpoint of its own. Test connection, in the
  add and edit dialogs, asks the provider what it lists on the dialog's values
  without saving them, the stored key standing in for a blank key box; Test on
  a provider's row asks the same of what it stores. Serve models not on its
  list, in both dialogs, makes a provider serve any model a request names, as
  a `config.yml` provider does, priced or not, while a model switched off on
  its list is still refused. It is off by default; a provider moved from the
  retired Deployment providers page starts with it off and every model it lists
  switched on, priced or not.
  A provider's name opens Models filtered to it, and above the table a summary
  counts the providers reachable, with Re-check all to ask them again. With no
  provider yet, the page walks through adding the first one, and offers to
  enable default pricing when pricing is required and nothing sets it. Adding
  a provider is disabled, with a banner saying why, while the server has no
  `OTARI_SECRET_KEY` to encrypt its key with. The
  table also lists the `providers:` instances of `config.yml`, marked
  config.yml and read-only, with their reachability. Providers stored on the
  retired Deployment providers page are moved here under the same names
  automatically at startup. Any that could not be moved are listed in a banner
  with the reason: once the cause is fixed, move it from there, or Discard it,
  since a row left behind serves nothing.
- Web search pricing and Code execution pricing, what the deployment charges
  per successful call of a tool it runs itself. Web search pricing lists the
  `otari:web_search` and `otari:web_fetch` rates and each search and fetch
  instance's own rate, saying which rate an instance with none of its own falls
  back to. Code execution pricing lists `otari:code_execution`. Edit sets a
  rate in dollars per call, in force from the moment it is saved, and 0 prices a
  tool as free. An instance whose rate comes from `price_per_call` in
  `config.yml` is marked and changed there. With `require_pricing` on, the page
  warns while a tool it lists has no rate, because a request that would run it
  is refused. See [Pricing a gateway-run tool](tools.md#pricing-a-gateway-run-tool).

Accounts and Hosted providers are listed only for a deployment operator, and
answer anyone else that they are not available to them. The two pricing pages
are listed for one too, and say the same to anyone else who opens them.

Settings shows the effective non-secret configuration. Some values can be changed
at runtime and others require a restart. The server marks that distinction in the
settings response.
Its Rate limit rules card adds, edits and removes limits on requests per minute,
tokens per minute and requests in flight; rules from config.yml are listed there
read-only.

What a page shows can also depend on who is signed in, not only on the
deployment. Spend and budgets is the clearest case: an organization owner or
admin manages their own organization's budgets and the spend ceilings holding
them, while a deployment operator gets the deployment's own budgets, their
active organization's, and the gateway users assigned to them. Usage, activity,
traces, routing and the overview's key count likewise show an operator their
active organization, not every organization on the deployment.

Providers answers to the organization role rather than to deployment authority.
Its owners and admins manage the keys, the models each key offers, and the rate
each model is billed at. An organization may set its own rate for a model it
supplies the provider key for. A model reached through one of the deployment's
own provider instances is not one of those: the deployment holds that credential
and settles its upstream bill, so its rate is the deployment price list's, which
is `/api/v1/pricing` and has no page of its own. The same holds for a model the
deployment serves on one of its hosted providers: a request served there is
priced only from a rate the deployment operator set, either the price list or a
rate the operator set for this organization, never from one the organization
wrote itself, even one written while its own key still covered the model. A rate
the operator set for an organization is listed beside the organization's own,
and only the operator may change or remove it. The models.dev defaults are
kept current by Update catalog on the Hosted providers page, or on a schedule
under `pricing_refresh`.

A rate is per million tokens, per request, or per image, and the rate form asks
which. A request or image rate is entered per 1,000, the way providers publish
one: $2 per 1,000 searches for a rerank model is entered as 2 and stored as 2000
per million, which is how every rate travels on the wire. The model lists name
such a rate by its unit, for example "$0.002 per request". The same choice is on
Activity's "Price this model", offered on a served request that carried no cost
(a failed attempt billed nothing, so its error is the guide instead), which
opens per request for a rerank, audio or moderation request and per image for
an image generation. The unit decides what
a rate bills. A token rate on an audio or moderation request is still read per
request for now and logs a warning; a later release reads it strictly, as
tokens, which those requests do not report, so price them per request.

Exact page names and availability can change with configuration and installed
extensions. The running dashboard is the source of truth.

What a page shows can also depend on who is signed in. On API keys, an operator
manages every key in the organization and chooses each key's owner, while a
member sees the same page scoped to their own keys, always billed to themselves
and never budget-exempt. An operator, or an organization owner or admin, can also
cap a key's own spend: the key's create and edit forms take an existing budget
or a custom amount and reset, and a Budget column shows each key's spend this
period against its limit. A key's Edit reports the routing its requests got,
and its Set up routing, like the step after creating a key, opens the
new-policy page for that key, starting on the model it sends most where that
is a `provider:model`. For an operator it opens the Routing list, with the
create dialog on that model when there is one. Where the deployment turns on
`federation_member_rules`, a key's actions menu offers Workload identity… to the
operator, and to an organization owner or admin on their own keys; see [Rules on
a member's own key](workload-identity.md#rules-on-a-members-own-key).

Overview splits the same way. It reads one calendar month in UTC, this one
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

## Playground

The Playground is the in-product chat page: pick a model the gateway serves and
talk to it, or put two side by side and record which answered better. Requests
run through the same path as any other completion, so routing policies,
guardrails, budgets and the tool loop all apply, and every request appears in
Activity and Usage.

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
therefore has no key attached. Picking a different model changes which provider
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
failed attempts are counted on it and listed under it on request. Opening a row
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
organization is offered to them only where `open_signup` is on, since the
gateway refuses it otherwise.

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

On Members, an invited row offers Reissue and Revoke, and says when its
invitation has expired. Reissue sends a new accept link (or shows it to share,
when the email did not go out) and the old one stops working, which is how a
lost link is recovered.

## Authentication options

Password sign-in works for an existing account. Optional passkeys, Google OAuth and GitHub OAuth add more ways to sign in. Set `passkeys_enabled: false` (`OTARI_PASSKEYS_ENABLED`) to switch passkeys off entirely. When the deployment sets `open_signup: true`, a new address can also create an account with its own organization, through the signup form or a Google or GitHub sign-in. Where the deployment publishes terms (`terms_url`), the signup page asks for them before any of those, and the invitation page asks before "Accept and sign in with a provider instead". A provider sign-in from the sign-in screen that would set up an account without them stops on the page the provider returns to, which asks for the terms and starts the sign-in again. A passkey never creates an account. OAuth requires `public_base_url` plus the provider's client ID and secret. Passkeys can instead use `public_base_url`, or an explicit `webauthn_rp_id` and `webauthn_allowed_origins` pair.

A link to a dashboard page opened while signed out shows the sign-in screen first, then that page once you have signed in, whichever of these methods you use.

Signing in *can* add a membership in one case. If an organization has claimed and
proven the email domain that the identity's verified address belongs to, the
sign-in joins them to that organization at the role the claim names, whichever of
the three credentials they used. It is the only path that grants membership
without somebody deciding about the person, and it is fenced accordingly: see
[Email-domain auto-join](access-control.md#email-domain-auto-join).

Mail is optional. When an invitation email does not go out (no mail, a failed send, or the
daily invitation mail limit), you get the accept link to share,
and an invitee new to the deployment chooses a password on the page it opens,
so a deployment without SMTP can still bring people in. See [Configuration](configuration.md#mail).
For an account that already exists, an operator can generate a password instead:
**Accounts**, then **Set password**, shows it once to hand over.

## Custom documentation

The dashboard's Documentation link opens [docs.otari.ai](https://docs.otari.ai/).
Set `docs_url` to make it open a different site.

## Legal pages

`terms_url` and `privacy_url` name where this deployment's terms of service and
privacy notice live. The account menu links each row it has an address for; see
[Configuration](configuration.md#legal-pages).

## Development

The dashboard source is under `web/`. The published Docker image includes the
bundle. A source checkout needs `make dashboard` for the gateway to serve it, or
`pnpm --dir web dev` for frontend development. See [web/README.md](../web/README.md).
