---
status: accepted
date: 2026-09-06
---

# Subscription plans first, any vendor, API keys through the same seam

Authenticate every agent run with a subscription plan (any vendor's) for as long as one can do the work, across as many accounts as needed, and avoid API billing, because subscription billing is what makes the factory's volume affordable. An API key is allowed, but through the one auth seam every run already goes through (`claudeAgent()` in `factory/lib/claude-agent.ts`, which was in `factory/agent-workflows/shared/common.ts` until #313 dissolved that module), not as the first choice. Today that means per-account `claude setup-token` OAuth tokens, one secret each, rotated by the factory's own module (ADR 0004).

The risk this runs, stated once: no vendor page states a rule for a harness that spawns the unmodified `claude` CLI, which is what the vendored engine (ADR 0002) does, so the research note reads that case as subject to discretionary usage-credit billing or blocking (sources in `docs/research/sandcastle-peers-2026-09.md` section 5). The answer is mechanical, not rhetorical: exactly one auth seam, so every path off subscription tokens is one secret change away.

## Considered Options

- **API billing as the default.** Rejected: subscription billing is what makes the volume affordable. A key is allowed through the same seam, but is not the first choice.
- **A build on the Agent SDK.** Closed: the vendor's compliance page points the SDK at API keys, so subscription tokens are refused there outright.

## Consequences

- Accounts must be distinct orgs; tokens in one org share a quota.
- The one seam is what lets auth flip to an API key with one secret change.
- Vendor-native runners (Anthropic's official action and peers) are the fallback engine for the same reason.
- Secret naming per vendor is a v1 concern: today's names are Claude-shaped (`CLAUDE_CODE_OAUTH_TOKEN_<n>`, `CLAUDE_ACCOUNT_<n>`); a second vendor means a second prefix plus a provider input.
