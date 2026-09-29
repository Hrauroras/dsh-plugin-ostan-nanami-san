# Publishing checklist

**Status: steps 1 and 2 are done. Only the push remains.**

Repository identity is filled in for [`Hrauroras`](https://github.com/Hrauroras):

| File | Field | Value |
| --- | --- | --- |
| `package.json` | `repository` | `git+https://github.com/Hrauroras/dsh-plugin-ostan-nanami-san.git` |
| `package.json` | `bugs` | `https://github.com/Hrauroras/dsh-plugin-ostan-nanami-san/issues` |
| `package.json` | `homepage` | `https://github.com/Hrauroras/dsh-plugin-ostan-nanami-san#readme` |
| `CHANGELOG.md` | 8 compare links | `https://github.com/Hrauroras/...` |
| `.github/ISSUE_TEMPLATE/config.yml` | contact link | points at the README section |

Verify nothing is left to fill in:

```sh
grep -rn "OWNER\|<your-user>\|<your name>" . --exclude-dir=.git   # expect: no output
```

---

## 1. Create the empty repository on GitHub

Name it `dsh-plugin-ostan-nanami-san`, owner `Hrauroras`.

Do **not** let GitHub add a README, `.gitignore` or license — this repository
already has all three, and initialising with them creates a conflict on the first
push.

## 2. Confirm the commit identity, then push

The single commit currently carries:

```
OSTan <OSTan@users.noreply.github.com>
```

Replace it with your own before pushing, so the authorship is yours:

```sh
git config user.name  "<your name>"
# GitHub's noreply address. Find your numeric id under
# Settings → Emails → "Keep my email addresses private"; the ID+username form
# is the one that survives a username change.
git config user.email "<your-id>+Hrauroras@users.noreply.github.com"

git commit --amend --reset-author --no-edit
```

Then:

```sh
git remote add origin https://github.com/Hrauroras/dsh-plugin-ostan-nanami-san.git
git push -u origin main
git push origin v0.6.0        # the annotated tag is already here
```

## 3. After pushing

- Add the repository **topics**: `dsh-plugin`, `deepseek-harness`, `desktop-pet`,
  `companion`, `chibi`.
- Confirm CI is green — `.github/workflows/tests.yml` runs the suite on Ubuntu and
  Windows against Node 22 and 24.
- **The four poses are not MIT.** `LICENSE` and `README.md` both say so, and the
  character is not original to this project. If you would rather not ship the
  artwork publicly, delete `assets/*.png` and `docs/*.png` before pushing: the
  plugin still loads, it just has no artwork to show.

## What was checked before hand-off

- `node --check` on both halves — clean.
- The full suite: **81 tests**, all passing.
- No dependency graph: `dependencies` and `devDependencies` are absent, so there is
  nothing to install and no lockfile to ship. `node_modules/` is gitignored anyway.
- No secrets, tokens or machine-specific config anywhere in the tree. The one local
  path that appears is in `README.md`, as a worked example of the `link:` install
  spec.
- `.gitattributes` pins line endings to LF so the shipped JavaScript is byte-stable
  across platforms, and marks `tools/*.py` as vendored diagnostics so they do not
  dominate the language statistics.
- The exported archive was produced with `git archive`, so it contains exactly the
  tracked files — no `.git`, no caches, no dependencies.
