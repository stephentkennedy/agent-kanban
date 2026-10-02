Work on task #{{task.id}}: {{task.title}}

- The task file is `{{task.path}}`. Edit that file, with its absolute path, to tick boxes and add notes.
  Your worktree has no copy of the tracker's task files.
- Your worktree is `{{worktree}}`, on branch `{{branch}}`. Make all code changes and commits there.
  Never commit kanban.jsonl or anything under the tracker's tasks/ folder, never merge your branch,
  and never switch branches: the orchestrator or the user merges it after review.

Start with `kanban show {{task.id}}` (and any #ids it depends on), then `kanban start {{task.id}}`. If an
open question blocks the work, ask with `kanban post {{task.id}} "<question>"` and stop until it is
answered. When the work is done and verified, commit it on your branch, append the implementation notes,
and run `kanban move {{task.id}} review`.
