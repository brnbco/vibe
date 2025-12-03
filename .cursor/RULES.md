# .cursor/RULES.md

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

* Maintain an up-to-date `.cursor/FILE_STRUCTURE.md`.
* Only document files **not ignored by `.gitignore`**.
* Reflect folder purpose, agent roles, and interfaces.
* Update structure after any major change.

---

---

## 🏗️ Infrastructure & Assets Register

* Track **any and all assets produced** (even for MVPs) in `.cursor/INFRASTRUCTURE.md`.
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

* When an issue takes **multiple chats/sessions** to debug or resolve, or some valueable insight that should be remembered to prevent progress, **append a concise entry** to `.cursor/LESSONS_LEARNED.md`.
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
* **No unit or integration tests yet**

Focus is on **functionality, iteration, and clarity.**

---

## ✅ Summary

This repo prioritizes:

* Clear dev communication (commits + structure)
* Simplicity
* Rapid prototyping

Build fast. Stay readable. Document just enough.
