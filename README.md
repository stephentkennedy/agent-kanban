# Kanban

A feature tracker that lives in your repo. Each task is a markdown file in `tasks/`. You edit it however you
like: in VS Code, from the CLI, or in the browser board. Each task's column, its place in that column,
its priority, type, tags and history are stored in `kanban.db`, a SQLite file beside it. `kanban.db`
is not committed. Its text form, `kanban.jsonl`, is (see [In git](#in-git)).

It has no dependencies. It needs Node 22.13 or later, for the built-in `node:sqlite`.

```sh
cd path/to/kanban
node kanban.js git-setup        # once per clone: the pre-commit hook and the merge driver
node kanban.js                  # the board, in the terminal
node kanban.js serve --open     # the board, in a browser at http://127.0.0.1:4477/
```

Run `npm link` once to get a `kanban` command that works from any directory. It always uses this
checkout's tracker.

## Tasks are files

```
tasks/
  _template.md                    new tasks start from this; {{title}} is filled in
  dark-mode-toggle.md
  bulk-buy-shows-wrong-cost.md
```

- **The title** is the file's first `# ` heading. Without one, the file name stands in for it. Renaming a
  task from the CLI or the board rewrites that heading.
- **Progress** is the file's task-list checkboxes, `- [ ]` and `- [x]`. The cards and `kanban list` show
  it as `2/4`. You can tick checkboxes in the board's preview, and doing so edits the file.
- **Everything else**, such as status, priority, type, tags and dates, is stored in the database.
  The files stay plain markdown, with no front matter.

Files starting with `_` or `.` are ignored.

### Editing files directly

Every command, and the running server, first reconciles `kanban.db` with `tasks/`:

| You do this in `tasks/`  | The tracker does this |
| --- | --- |
| Create `something.md`   | Adds it to the first column as a new task |
| Edit a file             | Picks up the new title and checkbox progress |
| Rename a file           | Keeps the task, its column and its history. It recognises the rename by identical content, or failing that by a title no other task shares. |
| Delete a file           | Marks the task *missing* and hides it without forgetting it. If the file comes back (for example after a `git checkout`), so does the task. `kanban prune` forgets missing tasks for good. |

The browser board updates live as files change and as the CLI makes changes. If a file changes while
you have unsaved edits to it in the board, the board asks whether to load the new version or keep yours.
It never silently overwrites either one.

## CLI

A task is named by its number (`12` or `#12`) or its file name, or by enough of the start of the file
name to be unambiguous (`kanban show dark`).

```sh
kanban                                   # every column
kanban list --tag ui --type bug          # one line each; --status --priority --search --all --json
kanban list --missing                    # also tasks whose files have gone
kanban show 12                           # metadata and the markdown; --json
kanban history 12                        # every change, renames included
kanban tags                              # tags in use, with counts; --json

kanban add "Offline progress report" --type feature --tags engine,ui --priority high
kanban add "Bulk buy rounding" --body "Steps to reproduce..."   # --body replaces the template, and the
                                         # heading comes from the title, so don't start the body with one
kanban add "Dark mode toggle" --status todo --edit     # opens $VISUAL/$EDITOR on the new file
kanban edit 12
code "$(kanban path 12)"

kanban move 12 review                    # --top, or --at 3 for a place in the column
kanban start 12                          # from a queue column to the first "active" one; a task
                                         # already active or done stays put (use move for rework)
kanban done 12                           # to the first "done" column
kanban set 12 --priority urgent --type bug --tag +engine,-ui --title "Better name"
kanban archive 12                        # hidden from the board; `list --all` shows it
kanban unarchive 12
kanban rm 12                             # deletes the task and its file; --keep-file keeps the file

kanban sync                              # reconcile now and say what changed
kanban prune
kanban export --stage                    # what the pre-commit hook runs
kanban import                            # rebuild kanban.db from kanban.jsonl
kanban help
```

Priorities are `low`, `normal`, `high` and `urgent`. Types are `feature`, `bug`, `content`, `chore`
and `idea`.

## Columns

The default columns are Backlog, To do, In progress (limit 3), Review and Done. Each column has a
*kind*:

- `queue`: work not started yet.
- `active`: work under way. A task's `started_at` is set the first time it enters one.
- `done`: finished. `completed_at` is set while the task sits in a `done` column, and cleared if it
  moves out.

```sh
kanban columns                           # --json
kanban column add blocked --label Blocked --kind active --after doing --wip 2
kanban column set doing --wip 4 --label "Doing"
kanban column set blocked --rename waiting --position 2
kanban column rm waiting --to todo       # moves its tasks out first
```

A work-in-progress limit is advisory. Going over it turns the column's count red on the board and
prints a warning in the CLI.

## The browser board

`kanban serve [--port 4477] [--open]` listens on 127.0.0.1 only.

- Drag cards between columns and within a column.
- Click a card to open it. You can change status, priority, type and tags, and rename it from the title.
  **Preview** renders the markdown, and you can tick its checkboxes. **Edit** edits the file itself, and
  Ctrl+S saves.
- **Open file** runs `$KANBAN_OPEN` on the task file, for example `KANBAN_OPEN=code kanban serve`.
  Without it, the desktop's default handler opens the file.
- Filter by search text, type, priority or tag. Clicking a tag on a card filters by it. Keyboard
  shortcuts: `/` searches, `n` adds a task, `Esc` closes the open task.
- `http://127.0.0.1:4477/#12` opens task 12 directly.

## In git

`kanban.db` is ignored. What git sees is `kanban.jsonl`, which holds the whole board as text: one line
for each column, then one line for each task, carrying its tags and history.

```json
{"id":3,"file":"bulk-buy-rounding.md","title":"Bulk buy rounding","status":"todo","position":2,"priority":"urgent","type":"bug","tags":["ui"],"created":"…","updated":"…","history":[…]}
```

- **Writing:** every change to the board rewrites `kanban.jsonl` straight away. It isn't only written
  at commit time. That way the file in your working tree is never behind the database, and a pull or
  checkout can't replace it while board changes are still uncommitted: git refuses, as it would for
  any modified file.
- **The pre-commit hook** runs `kanban export --stage`. This picks up anything that changed without a
  kanban command running, such as a task file edited in VS Code (its title or progress) or a new file
  dropped into `tasks/`, and stages `kanban.jsonl` with the commit. The hook stops a commit only when
  the board can't be read, which in practice means conflict markers were left in `kanban.jsonl`.
- **Reading:** when `kanban.jsonl` changes under the database (after a clone, pull, checkout, merge or
  rebase), the next command, or the running board, rebuilds `kanban.db` from it. A fresh clone needs
  nothing beyond `git-setup`.
- **Moving a task** gives it a position between its new neighbours, so a move changes only that task's
  line.

### Merging

`.gitattributes` gives `kanban.jsonl` a merge driver that merges the board task by task rather than
line by line:

- A task changed on only one side takes that side's version. When both sides changed a task, the
  change is merged field by field, and tag additions and removals from both sides are kept. History
  is combined.
- When both sides changed the same thing, the later change wins. For example, if both moved the same
  task, the later move wins. The driver prints what it decided.
- Two branches that each created, say, `#12` both keep their task, and theirs is renumbered.
- A task deleted on one side but edited on the other is kept.

`git-setup` registers the driver, because git config isn't committed. Without it, git falls back to a
normal text merge. If that produces conflict markers, `kanban` refuses to load the file until they're
resolved. Keeping both sides' lines is always safe: a task that appears twice keeps its first line,
and two tasks sharing an id are renumbered. The tool tells you when it does either.

`KANBAN_HOME` (or `--home <dir>`) points the tool at a different tracker directory, which is useful
for trying things out without touching the real board.
