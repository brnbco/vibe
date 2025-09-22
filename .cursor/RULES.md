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
