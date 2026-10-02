# Writing a task

The house style for tasks in `tools/kanban/tasks/`. If the repo already has tasks, skim a few of
the finished ones (`kanban list --status done`) for tone, and follow any local conventions they show.

## Shape

```markdown
# <Title>                      <- written by `kanban add` from the title; leave it out of --body

<One paragraph: why this matters to users or the project, and what depends on it (#id).>

## Now

- What the code does today, with real locations: `src/session.js:120`, `Session.prototype.refresh`,
  `api.applyPatch` (`src/api/core.js:1826`). Numbers where they matter.
- What's missing or broken, stated as fact. Only what you have read or measured.

## Proposal

- The intended change, in enough detail to implement: data shape, where logic lives, what gets
  stored, how it migrates, what the UI shows.
- Name constraints the codebase imposes (migrations, caching, compatibility, test coverage) where
  they apply.

## Done when

- [ ] Each item a checkable outcome, not an activity ("Export of 10k rows completes in under
      2 s in Chromium and Firefox", not "Fix the export")
- [ ] Regressions that must still pass (e.g. the existing test suite, benchmarks unchanged)
- [ ] Changelog entry (`new` / `fix`), if user-visible

## Open questions

- **Short label?** The choice the user has to make, with the options. Once settled:
  "Decided: …" and a line of reasoning.

## Notes

- Optional: hints for whoever implements it, links between tasks.
```

Variations seen in the repo, and fine to use when they fit better:
- A bug found by investigation may use `## Found` (the measured symptoms) and `## Fix` instead of
  Now / Proposal.
- Omit Open questions if there are none; omit Now for a pure idea with no existing code.

## Style

- Plain and specific. Match the repo's spelling conventions.
- Short bullets over prose. Bold the one fact a reader must not miss.
- Code identifiers and paths in backticks. Cross-reference other tasks as `#5`, never by title alone.
- "Done when" boxes must be verifiable by someone else: a measurement, a behaviour, a passing check.
  Three to six is typical.
- Don't pad: no "Background", "Goals", "Acceptance criteria" headings; the ones above are the house
  set.

## Implementation notes (appended when the work is finished)

```markdown
## Implementation notes

- `src/session.js`: what changed, by function. New names in backticks.
- `src/ui/banner.js`: …
- **Deviation:** what differs from the Proposal, and why.

Verification:
- What was run and what it showed (tests, browsers, numbers).
- Not tested: what couldn't be verified, and why.
- Leftover: anything noticed and deliberately left alone.
```

Group by file or by area (Backend / UI / Tooling) for bigger changes.
Be honest about what wasn't checked: an unticked box with a reason is more useful to the reviewer
than a ticked one that isn't true.
