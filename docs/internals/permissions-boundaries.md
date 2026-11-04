# Permission boundaries

The provider decides whether an agent's action runs: its modes, rules, sandbox,
approval decisions and what a remembered decision persists. Stark shows the
provider's request and returns the user's answer. Stark keeps its own authority
over what only Stark can do: its MCP tools, the workers and threads an agent
starts through them, scheduled runs, and delivering the answer. Mixing the two is
how permissions widen without anyone choosing it.

## Stark's authority comes from what the provider runs

A thread's stored mode is a request, not proof. The brand clamp runs every
non-Claude session Supervised whatever the thread stored, and a provider runs a
mode it no longer offers as Supervised. Caller limits and the environment
authority that project and settings tools need are therefore computed from the
preset the provider really runs
([PermissionContainment](../../apps/server/src/orchestration-v2/PermissionContainment.ts)),
from the caller's own provider session. A thread that follows its provider's own
settings, which Stark cannot read, grants Supervised and counts as the broadest
preset when another caller targets it.

## Presets order only within one provider instance

Two threads on the same instance share its native settings, so comparing their
presets is meaningful. Across providers or instances it is not: Claude's Accept
edits says nothing about what a Codex profile allows. A worker on its parent's
instance asks for no more than the parent's real preset; a worker anywhere else
starts only at that provider's narrowest mode, when the agent names it, and is
labelled as not limited by the parent's rules. Anything Stark cannot establish is
refused rather than translated. Workers never run Bypass, a deliberate Stark
policy rather than a provider rule.

The orchestrator decides a worker's policy itself, under the parent thread's
lock, for every sender: Stark's MCP tools and a client dispatching the
delegation directly alike. A policy the command carries is never trusted. The
worker stores the preset its provider actually runs, so a Codex worker asked
for Auto is stored and labelled as Supervised, the floor it runs at.

## Scheduled runs never widen a shared thread

A task bound to a thread runs with that thread's settings. When the thread now
asks for more than the task allows, follows its provider's own settings, or moved
to another provider, the run is refused with that reason in its history. Stark
never changes the thread to fit the run.

## Choice, delivery and execution are separate

Recording the user's answer is not delivering it, and delivering it is not the
action running. The respond effect reports delivered, not delivered (Stark never
sent it, or the adapter proved nothing was waiting) or uncertain (the handover
failed inside the adapter), and a failure is reported before its outbox row
settles. A process that dies in between, or a report that never lands, leaves
the answer to startup recovery, which marks it uncertain. A request the provider
closed itself is never answered a second time, and a provider re-sending a
request never replaces the choice, delivery or loss Stark recorded on it.

Delivered means the answer left Stark, not that a local waiter woke up. Codex's
request handler reports whether its result was encoded and accepted by the
live transport, and the adapter waits for that. Claude's SDK reports no write
acknowledgement, so an answer counts as delivered once the SDK took the
callback's result while the request was still open (its signal not aborted);
a write that fails on a pipe the SDK has not yet noticed is closed is the
remaining gap. A provider closure that reaches the ingestor before the request
it closes is remembered, and the request is stored already closed.

## Stark-owned tools validate their own inputs

Provider approval does not cover what a Stark tool does with its arguments.
`html_render` and `html_preview` read local images Stark can reach, outside any
provider's read rules, so the image byte check in
[HtmlRender](../../apps/server/src/htmlRender/HtmlRender.ts) is the boundary and
neither tool is pre-approved. The read-only shell classifier explains a command
on an approval card and never decides one.
