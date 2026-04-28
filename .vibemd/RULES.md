# .vibemd/RULES.md

## 📦 Commit Discipline

- Make **frequent, atomic, and purposeful commits**.
- Use conventional prefixes:  
  - `feat`: new features  
  - `bug`: bug fixes  
  - `chore`: build, deps, or cleanup  
  - `refactor`: code restructuring  
  - `docs`: updates to documentation  
  - `style`: formatting, comments, etc.  

**Examples:**
```sh
git commit -m "feat: add agent state handler"
git commit -m "chore: update README with local dev instructions"
````

---

## 📚 File Structure Awareness

* Maintain an up-to-date `.vibemd/FILE_STRUCTURE.md`.
* Only document files **not ignored by `.gitignore`**.
* Reflect folder purpose, agent roles, and interfaces.
* Update structure after any major change.

---

## 🧱 Architecture

* Maintain `.vibemd/ARCHITECTURE.md` as the **system-level blueprint**.
* Document high-level component boundaries, service topology, and interaction patterns (sync vs async, request/response vs pub/sub).
* Include diagrams or ASCII-art to clarify relationships between major subsystems.
* Update whenever a new service, worker, or major component is introduced or removed.

Commit example:

```sh
git commit -m "docs: update ARCHITECTURE with queue-worker topology"
```

---

## 🌐 Network

* Maintain `.vibemd/NETWORK.md` to capture **all network-facing concerns**.
* Include diagrams or ASCII-art to clarify topology.
* Document API routes/endpoints, service-to-service communication, ports, protocols, DNS entries, WebSocket channels, and any external integrations.
* Note environment-specific differences (local dev vs staging vs prod) when they exist.
* Update when routes are added/removed or connectivity between services changes.

Commit example:

```sh
git commit -m "docs: add webhook callback route to NETWORK"
```

---

## 🔌 Integrations

* Maintain `.vibemd/INTEGRATIONS.md` to document **all external systems and required local bindings**.
* Cover authentication state, CLI/tooling setup, linked accounts/projects/tenants, and any required local configuration to interact with external services.
* Include identity providers, cloud environments, DNS/CDN providers, third-party APIs, and certificate requirements.
* Document **how to authenticate, configure, and verify access**, not just that it exists.
* Capture any assumptions about the developer/operator environment that are required for the system to function.

Examples include:

- Auth0 CLI authenticated and linked to a specific tenant
- `gcloud` configured and authorized for a project
- Cloudflare DNS usage and required local certificates
- Required local config files, paths, or environment variables

> ⚠️ Never include secrets. Only document how to obtain, configure, or rotate them.

Commit example:

```sh
git commit -m "docs: add Auth0 and GCP setup to INTEGRATIONS"
```

---

## 🛠️ Tech Stack

* Maintain `.vibemd/TECH_STACK.md` as the **canonical list of approved technologies**.
* Cover languages, frameworks, runtimes, package managers, databases, message brokers, hosting/deploy targets, and key libraries.
* Include version constraints or ranges where they matter.
* Update when a technology is added, replaced, or upgraded to a new major version.

Commit example:

```sh
git commit -m "docs: add Redis to TECH_STACK for session caching"
```

---

## 🗃️ Data Model

* Maintain `.vibemd/DATA_MODEL.md` to describe **all persistent and transient data structures**.
* Document database schemas, entity relationships, key indexes, enums/constants, and data-flow contracts between services.
* Use tables, ER-style notation, or TypeScript/SQL type definitions—whatever communicates most clearly.
* Update when schemas migrate, new entities are introduced, or relationships change.

Commit example:

```sh
git commit -m "docs: add project entity and relations to DATA_MODEL"
```

---

## 🔒 Security

* Maintain `.vibemd/SECURITY.md` to capture the **security posture and policies** of the project.
* Document authentication strategy, authorization model, secrets management approach, input validation rules, CORS policy, rate limiting, and any compliance requirements.
* Note known threat vectors and their mitigations.
* Update when auth flows change, new secrets are introduced, or the threat model evolves.

> ⚠️ **Never commit actual secrets.** Document *how* to obtain/rotate them and where they are stored, not the values themselves.

Commit example:

```sh
git commit -m "docs: document JWT auth flow and token rotation in SECURITY"
```

---

## 🏗️ Infrastructure & Assets Register

* Track **any and all assets produced** (even for MVPs) in `.vibemd/INFRASTRUCTURE.md`.
* Assets include: temporary scripts, schemas, generated keys/tokens (never store secrets), cloud buckets, keystores, queues, local services, docker images/tags, datasets, dashboards, external webhooks, and any manual steps needed to recreate them.
* Keep this **lightweight but current**—prefer a table with:

  * **Name/ID**
  * **Type** (bucket, queue, script, dataset, etc.)
  * **Purpose**
  * **Location** (path/URL/registry)
  * **Lifecycle** (temp, persistent)
  * **Owner** (person/team)
  * **Creation/Change Date**
  * **Notes** (deletion steps, cost, TTL)

**Table template:**

```md
| Name/ID            | Type     | Purpose                | Location/Path                     | Lifecycle | Owner  | Date       | Notes |
|--------------------|----------|------------------------|-----------------------------------|----------:|--------|------------|-------|
| events-queue-dev   | queue    | local event fanout     | nats://localhost:4222             |   temp    | alice  | 2025-10-13 | delete after demo |
| bootstrap-dataset  | dataset  | seed test data         | data/bootstrap/seed.csv           | persistent| bob    | 2025-10-13 | regen via /scripts/seed.sh |
```

Commit example:

```sh
git commit -m "docs: record assets in INFRASTRUCTURE (dev queue, seed dataset)"
```

> ⚠️ **Secrets Policy:** Never commit secrets. If a secret is generated, log only *how to obtain/rotate it* and where it’s stored (e.g., “in 1Password vault X”), not the value.

---

## 🧠 Lessons Learned Log (multi-chat debugging)

* When an issue takes **multiple chats/sessions** to debug or resolve, or some valueable insight that should be remembered to prevent progress, **append a concise entry** to `.vibemd/LESSONS_LEARNED.md`.
* For each entry, include:

  * **Context:** what we were trying to do
  * **Symptoms:** what went wrong (errors, unexpected behavior)
  * **Root Cause:** why it happened
  * **Resolution:** what fixed it
  * **Prevention:** guardrails or checks to avoid repeats
  * **Refs:** PRs/commits/links

**Template:**

```md
### [YYYY-MM-DD] <short title>
**Context:** …
**Symptoms:** …
**Root Cause:** …
**Resolution:** …
**Prevention:** …
**Refs:** #<PR>, <commit>, <link>
```

Commit example:

```sh
git commit -m "docs: add lessons learned on auth callback race condition"
```

---

## 🚫 Out of Scope for MVP

To stay lean and iterative (unless explicitly directed otherwise):

* **No CI/CD setup**
* **No Terraform or infra-as-code**

Focus is on **functionality, iteration, and clarity.**

---

## 🛑 Execution Discipline

* **Do not use workarounds.**
* **Do not implement fallbacks.**
* If a task cannot be completed correctly or assumptions are unclear, **stop immediately and prompt for clarification**.
* **Do not violate defense-in-depth principles.**
* **Do not expose systems or services externally unless explicitly required.**
* **Do not expose anything publicly by default.**
* **All communication must use end-to-end SSL/TLS**, except in explicitly defined local development scenarios.

* Prioritize correctness, security, and explicit direction over guessing or patching incomplete solutions.


Commit example:

```sh
git commit -m "docs: add execution discipline rules"
```

---

## ✅ Summary

This repo prioritizes:

* Clear dev communication (commits + structure)
* Simplicity
* Rapid prototyping

Build fast. Stay readable. Document just enough.

## Finally

DO NOT USE FALLBACKS. DO NOT USE WORK AROUNDS. IF YOU'RE CHALLENGED, YOU MUST STOP AND PROMPT ME.
