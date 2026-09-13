---
name: workbuddy-connect
description: Install, inspect, refresh, or remove a local WorkBuddy CN or global account bridge for OpenCodex and Codex. Use for a user's own WorkBuddy desktop login; not for sharing credentials or calling WorkBuddy directly.
---

# WorkBuddy Connect

Connect the user's locally signed-in WorkBuddy desktop app to their local OpenCodex instance. The bundled bridge supports CN, global, or both regions and keeps desktop login files read-only.

Use the bundled package at `assets/bridge`. Before choosing a command or troubleshooting a package-specific behavior, read [`assets/bridge/README.md`](assets/bridge/README.md). It is the source of truth for its supported arguments, local provider names, and diagnostic output.

## Boundaries

- Work only with the current user's own desktop login. Detect account state through the bridge status and model-list commands; never print, copy into chat, or place raw access/refresh tokens in shared output.
- Do not change desktop application files, reinstall OpenCodex, or touch another person's bridge, state directory, or startup entry.
- Keep the runtime code and its state local. Do not write desktop credentials, bridge state, runtime JSON, logs, or generated configuration into the shared skill package.
- Listing status or models is a non-billed check. Do not send an inference request merely as an installation check. If the user explicitly asks for a connectivity test, first select a model returned by the selected region's model list and say that the test may consume the account's quota.

## Install or update

1. Check that Node.js is version 24 or newer and that the user's local OpenCodex service is running. Use the package README for the appropriate health command; repair or reinstall neither unless the user asks.
2. Run `node assets/bridge/src/cli.ts accounts` from the skill directory to discover the user's CN and global desktop logins without creating state or calling the model service. The `status` command instead checks an already running bridge and cannot be used before a first install. Select `auto` by default; use `cn`, `global`, or `both` only when the requested scope calls for it.
3. Put a complete copy of `assets/bridge` in a stable local code directory. The standard location is `$env:USERPROFILE\.opencodex\workbuddy-connect\app`; a user-selected local directory is also valid. If that directory already contains an installation, inspect it first. Preserve a dated local backup of its files before replacing them, rather than silently overwriting local modifications. Keep bridge state outside the copied bundle as the README specifies.
4. Run the copied `scripts/Install.ps1` with `-Region auto` unless a different region was chosen. The installer registers the discovered regions with OpenCodex and a current-user Windows task that supervises the bridge independently of the calling terminal. Pass the documented state directory when one is already in use so an update retains local continuity. Do not replace this with a raw background `Start-Process`: that can disappear with the calling tool session and leave OpenCodex returning 502. With autostart enabled, periodic task re-entry also recovers when the entire supervisor is terminated; manually stopping the task is temporary, so use the uninstall script to disable it before removal. If Task Scheduler is denied by local policy, report that restriction; do not claim a durable installation.
5. Verify the bridge status and list its registered models through OpenCodex. Report discovered regions and provider/model availability, never token data. A missing region means the user needs to sign in to that WorkBuddy desktop variant; it is not an installation failure for the other region.

## Status and refresh

For status, use the copied bridge's status command and OpenCodex health/model checks from the README. Distinguish these states clearly: OpenCodex unavailable, bridge stopped, a region signed out, and a region signed in but with no callable model returned.

For a login refresh, let the bridge use its normal refresh flow. If it reports signed out or an expired desktop session, ask the user to sign in again in their own WorkBuddy desktop app, then start or restart the local bridge and re-check status/models. Do not alter the desktop credential file.

For a bridge-package refresh, back up the existing local app directory, replace it with the new complete bundled copy, rerun `scripts/Install.ps1` with the existing state directory and selected `-Region`, then perform the same non-billed verification. Read the README when the package version changes.

## Remove

Run the copied `scripts/Uninstall.ps1` against the same local state directory. Verify that the associated provider registration and its startup entry are gone, while OpenCodex itself remains healthy. Leave the local bridge source and state in place unless the user explicitly requests deletion; never delete desktop credential files.

## Connectivity test

Only when the user asks for an actual request, choose a discovered model for the requested region and run the package's bounded smoke command from its README. Keep the prompt minimal, report the result without credentials or full logs, and stop after one successful request or one actionable failure.
