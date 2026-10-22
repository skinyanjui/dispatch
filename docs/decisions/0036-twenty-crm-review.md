# 0036 — Review of the Twenty CRM for ideas (no code reused)

## Context

We were asked to look at https://github.com/twentyhq/twenty and bring over what fits. It is a general-purpose open-source CRM (React front end, NestJS and GraphQL server, a metadata-driven object model).

## Licence decision

Twenty is **AGPL-3.0**, and some files are under a separate commercial licence (`/* @license Enterprise */`). Copying or adapting its code into Relay would require Relay's own source to be offered under the AGPL to everyone who uses it over a network, and the enterprise files cannot be reused at all. So **no Twenty code, assets or text was copied or translated.** The clone was read for product ideas only, and every feature below was written from scratch for Relay's own domain, data model and tests. If a future change wants to use Twenty code directly, that needs a deliberate licensing decision first.

## What was adopted (ideas only)

- A **command menu** (Ctrl or ⌘ + Shift + K): go to any page, start a new load, open a queue, jump to a carrier's loads, or search loads. Ctrl+K stays the page search.

## Considered, not adopted

- A **generic metadata-driven object model** and a workflow builder: Relay's domain (loads, carriers, billing, exceptions) is fixed and has its own authorization and isolation rules (tenant and carrier checks in every query). A generic layer would weaken those guarantees and is a rewrite, not a feature.
- **GraphQL and a NestJS server**: Relay is a Next.js modular monolith with a tested REST contract (ADR on architecture). Replacing it adds risk without a user-visible gain.
- **Saved views, notes and tasks on every record, email and calendar sync**: good fits for later. Each needs its own server model, consent and audit design, so they are backlog items rather than part of this change.

## Rollback

The command menu is a client-only component; removing it changes nothing else.
