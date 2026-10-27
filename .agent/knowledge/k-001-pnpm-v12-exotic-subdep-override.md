---
id: "k-001"
title: "Resolve pnpm v12 ERR_PNPM_EXOTIC_SUBDEP and Unapproved Lifecycle Scripts"
date: 2026-10-27
tags:
  - "tooling"
  - "pnpm"
  - "baileys"
severity: "medium"
affected_components:
  - "package.json"
  - "pnpm-workspace.yaml"
symptoms:
  - "ERR_PNPM_EXOTIC_SUBDEP: Exotic dependency 'libsignal' (resolved via git-repository) is not allowed in subdependencies"
  - "ERR_PNPM_IGNORED_BUILDS: Ignored build scripts: @whiskeysockets/baileys, esbuild, protobufjs, puppeteer"
---

# [k-001] Resolve pnpm v12 ERR_PNPM_EXOTIC_SUBDEP and Unapproved Lifecycle Scripts

## Problem / Symptom
When installing `@whiskeysockets/baileys` under pnpm v12+, installation fails immediately because Baileys 6.7.x declares `"libsignal": "git+https://github.com/whiskeysockets/libsignal-node.git"`. Modern pnpm v12 enables `blockExoticSubdeps` by default to prevent untrusted git repository resolutions in transitive dependencies:

```text
Error: ERR_PNPM_EXOTIC_SUBDEP
  × installing dependencies
  ╰─▶ Failed to resolve dependency tree: Exotic dependency
      "libsignal" (resolved via git-repository) is not allowed in
      subdependencies when blockExoticSubdeps is enabled
```

Furthermore, pnpm v12 ignores postinstall/build lifecycle scripts unless explicitly allowed, failing with:

```text
Error: ERR_PNPM_IGNORED_BUILDS
  × installing dependencies
  ╰─▶ Ignored build scripts: @whiskeysockets/baileys, esbuild, protobufjs, puppeteer
```

---

## Approved Solution
Define dependency overrides in `pnpm-workspace.yaml` mapping `libsignal` to the canonical npm release `2.0.1`, and allow explicit build scripts under `allowBuilds`:

```yaml
overrides:
  libsignal: "2.0.1"

allowBuilds:
  '@whiskeysockets/baileys': true
  esbuild: true
  protobufjs: true
  puppeteer: true
```

Run `pnpm install` or `pnpm approve-builds --all` to persist approvals into the lockfile.

**Root Cause:**
pnpm v12 moved `package.json#pnpm` overrides to `pnpm-workspace.yaml` and enforces supply-chain isolation against nested git URLs. Whiskeysockets published the identical build of `libsignal-node` to npm as `libsignal@2.0.1`, allowing clean registry-based resolution.

---

## What NEVER to Do
- ❌ **Anti-Pattern:** Attempting to disable global security policies or downgrading to npm/yarn without user consent.
  - *Why:* Violates project stack invariants and removes supply-chain protections.
- ❌ **Anti-Pattern:** Manually modifying `node_modules` after a failed installation.
  - *Why:* Non-reproducible across CI and clean checkouts.

---

## Verification
```bash
pnpm install && pnpm test
```

---

## References
- [pnpm Supply Chain Security Settings](https://pnpm.io/settings)
- [@whiskeysockets/baileys GitHub Repository](https://github.com/WhiskeySockets/Baileys)
