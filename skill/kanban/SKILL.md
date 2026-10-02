---
name: kanban
description: How to use the repo's own kanban feature tracker (usually tools/kanban, CLI `node tools/kanban/kanban.js`) to plan, record, pick up, work and hand off features, bugs and tasks. Use this whenever work in this repo touches the board or a task, even if "kanban" is never said. For example "add this to the board", "make a task/ticket for that", "what's next?", "what's in progress / in Review?", "work on #4", "pick up the dark mode task", writing up an audit or bug findings as tasks, reviewing or reporting on task status, or when you (or a subagent) have been given a task number like #12. Not for ordinary coding that no task or board is involved in.
---

# Kanban

The repo tracks its work in `tools/kanban/`. (That is the usual location; if this repo keeps the
tracker somewhere else, read every `tools/kanban` below as that path.) Each task is a markdown file in
`tools/kanban/tasks/`;
its column, priority, type, tags and history live in a SQLite database beside it. You work it through
a small CLI. The user reads the same board in a browser, and **reviews and closes your work
themselves**, so the board has to say accurately what you did and did not do.

## The CLI

Always run it from the repo root:

```sh
node tools/kanban/kanban.js                  # the whole board, column by column
node tools/kanban/kanban.js help             # every command and flag
```

Below, `kanban` is short for `node tools/kanban/kanban.js`. For anything not covered here, run
`kanban help` or read `tools/kanban/README.md`. Both are short and accurate.

**Naming a task:** its number (`4` or `'#4'`, quote the `#` in the shell), its file name, or enough
of the start of the file name to be unambiguous (`kanban show dark`).

| Want | Command |
| --- | --- |
| See the board | `kanban` |
| Filter | `kanban list --status review` (also `--tag`, `--type`, `--priority`, `--search`, `--all` for archived) |
| Read a task | `kanban show 4` |
| Machine-readable | add `--json` to `list`, `show`, `tags` or `columns` |
| Find its file | `kanban path 4` |
| Tags in use | `kanban tags` |
| Start work | `kanban start 4` (to the first *active* column, In progress) |
| Hand off for review | `kanban move 4 review` |
| Re-prioritise / retag | `kanban set 4 --priority high --tag +api,-ui` (`--tags a,b` replaces all) |
| Rename | `kanban set 4 --title "Better name"` (rewrites the file's `# ` heading) |
| What happened | `kanban history 4` |

Columns (`kanban columns`): `backlog` and `todo` are kind **queue** (not started), `doing` (In
progress) and `review` are kind **active** (under way), `done` is kind **done**. A WIP limit (In
progress has 3) is **advisory**: going over prints a warning and turns the count red, nothing is
blocked. Mention it to the user if you trip it, but don't refuse to start work because of it.

Prefer `--json` whenever you are going to parse output; the plain output has colour and alignment.

## Files versus the database

- **The markdown file is the content.** The title is its first `# ` heading; progress is its
  `- [ ]` / `- [x]` checkboxes (checkboxes inside code fences don't count). There is no front matter.
  Edit the file directly with your normal edit tools, found via `kanban path <n>`. To tick a box,
  change `- [ ]` to `- [x]` in the file. The next `kanban` command picks it up.
- **Status and metadata live in `tools/kanban/kanban.db`** (gitignored). Its committed text form is
  `tools/kanban/kanban.jsonl`, rewritten automatically on every change.
- **Never hand-edit `kanban.jsonl` or `kanban.db`.** Change status, priority, type, tags and titles
  only through the CLI; otherwise the database and the file disagree and the history is lost.
- Don't create, rename or delete task files by hand when a command exists for it (`add`, `set
  --title`, `archive`). The tracker tolerates it, but the CLI keeps history cleaner.

## Adding a task

1. **Check it isn't already there:** `kanban list --all --search <word>`.
2. **Investigate before writing.** A task's "Now" section cites real code locations, so read the code
   and get the file:line or function names right. Don't guess them.
3. **Write it in house style.** Read `references/task-writing.md` in this skill for the structure,
   the tone, and a worked example. In short: a one-paragraph *why*, then `## Now`, `## Proposal`,
   `## Done when` (verifiable checkboxes), and `## Open questions` for decisions that belong to the
   user. Refer to other tasks as `#id`.
4. **Choose metadata deliberately:**
   - `--type`: `feature`, `bug`, `content` (text, data, assets), `chore` (tooling, cleanup),
     `idea` (not yet agreed to).
   - `--priority`: `low`, `normal`, `high`, `urgent`. Most things are `normal`; `high` means it
     blocks other work or badly hurts users; keep `urgent` for data loss or a broken build.
   - `--tags`: reuse existing ones (`kanban tags`).
     Only invent a tag when none fits.
   - `--status`: leave it off (lands in Backlog) unless the user says it is up next (`todo`).
5. **Create it** with a quoted heredoc, so backticks and `$` survive the shell:

```sh
node tools/kanban/kanban.js add "Session timeout warning" --type feature --priority normal --tags ui --body "$(cat <<'EOF'
Users who leave the tab open overnight come back to a silently expired session...

## Now

- `session.refresh` runs on a 15-minute timer (`src/session.js:120`) and fails silently.

## Done when

- [ ] A warning shows when the session has under 2 minutes left
EOF
)"
```

The `--body` must **not** start with a `# Title` line: the CLI writes the heading from the title
argument, and a second one would be duplicated. The command prints the new number and file path;
report both to the user. If it warns that a task already has this title, it has still added yours:
`kanban show` the existing one, and if it's the same work, `kanban rm` the new one and use the old.

Short titles, imperative or a noun phrase: "Session timeout warning", "Export to
CSV", "Top bar: stable layout while numbers change". No trailing full stop.

## Working a task

When asked to work on a task (or handed a number):

1. **Read it**: `kanban show <n>`. Read any `#id` it depends on. If something in Open questions
   blocks the work, ask the user before starting and record the answer (see below).
2. **Start it**: `kanban start <n>`. Do this before writing code, so the board shows it's in hand.
   `start` only moves a task that hasn't begun. On one already in progress, Review or Done it says so
   and leaves it. For rework the user asked for, move it back yourself: `kanban move <n> doing`.
3. **Do the work.** Keep the task file in step as you go.
4. **Tick a "Done when" box only when you have actually verified it**: ran it, measured it, tested
   it. "Should work" doesn't count. If a box can't be satisfied, or you only partly checked it, leave
   it unticked and say why in the implementation notes. The user trusts the `5/5` on the card.
5. **Append `## Implementation notes`** at the end of the file:
   - what changed and where (files, functions, new names),
   - deviations from the Proposal, marked as such, and why,
   - how it was verified (commands, browsers, numbers),
   - what's left undone, not tested, or pre-existing and unrelated.
6. **Hand it off**: `kanban move <n> review`.

**Never move a task to Done** (`kanban done`, or `move … done`). Review is where your work stops;
the user reviews it and moves it to Done themselves. Likewise don't archive or `rm` tasks unless the
user asks.

**Decisions:** when the user settles an Open question (in conversation or when you ask), write it
into the task's `## Open questions` as "Decided: …" next to the question, so the next reader doesn't
re-ask it.

**New work found along the way:** a separate bug or follow-up gets its own task (`kanban add`), cross-
referenced by `#id` from the current one, rather than being silently folded in.

## Reporting on the board

- "What's next?": `kanban list --status todo`, then the Backlog, by priority (`list` is in board
  order: column, then position). Suggest one or two with a reason; don't start one unasked.
- "What's in Review?": `kanban list --status review`, then `kanban show <n>` for each the user wants
  to go through. Summarise the implementation notes and flag unticked boxes.
- An audit or review of the code that finds several problems: one task per independent problem,
  each written in house style, then a summary listing the new numbers.

## Delegating to a subagent

Give the subagent the task number **and** its file path (`kanban path <n>`), and tell it to follow
the kanban skill at `.claude/skills/kanban/SKILL.md`: start the task, tick only verified boxes,
append implementation notes, move it to Review, never to Done. Check its notes when it returns.

## Git

- Commit `tools/kanban/kanban.jsonl` together with the task-file changes it describes. The
  pre-commit hook runs `kanban export --stage`, which refreshes and stages it for you. (Only commit
  when the user asks.)
- A fresh clone needs `node tools/kanban/kanban.js git-setup` once, to install that hook and the
  `kanban.jsonl` merge driver.
- After a pull, checkout or merge, the next command rebuilds `kanban.db` from `kanban.jsonl`
  automatically. The merge driver merges `kanban.jsonl` task by task. If the file ever contains
  conflict markers, the driver wasn't registered: the CLI refuses to load it. Resolve by keeping
  **both** sides' lines (always safe; duplicates are dropped or renumbered), run `git-setup`, and
  tell the user.

## The browser board

`node tools/kanban/kanban.js serve --open` serves the board at http://127.0.0.1:4477/ (`/#12` opens a
task). It's for the user to look at. You should use the CLI, not the GUI, and don't leave a server
running unless the user asked for one.

## Trying things out

To experiment without touching the real board, point the tool at a scratch directory:
`KANBAN_HOME=<scratch dir> node tools/kanban/kanban.js …`. It creates a fresh empty tracker there.
