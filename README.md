# launch-agent

A Claude Code mod that adds `/launch`: fuzzy-find any repo or folder on your machine and start a background Claude agent there, without leaving the session you're in.

## Use

```
/launch            # open the picker
/launch api        # open it with "api" already searched
/launch ~/Projects # open it at a path
```

In the pane:

- **Find** searches folders you've launched from, your most-used folders (from [zoxide](https://github.com/ajeetdsouza/zoxide), if installed), every git repo under `$HOME` (5 levels deep), and the subfolders of the selected folder. Enter picks the top match and moves to **Task**.
- Type a path (`~/Pro`, `../`, `/etc`) and Enter completes it like a shell: `~/Pro` → `~/Projects/`, Enter again picks it.
- **Inside** lists `../` and the subfolders of the selected folder, for drilling down.
- **Task** is what the agent should do; Enter (or **Launch agent in …**) runs `claude --bg "<task>"` in that folder. Leave it empty to start an idle session.

The new agent shows up in `claude agents`; the pane shows its id, and `claude attach <id>` opens it. Esc closes the pane.

## Install

At a Claude Code prompt:

```
/plugin install launch-agent --marketplace KeepThisTicket/claude-launch-agent
```

Answer `y` to add the marketplace, then pick a scope (user = every session).

Or from a local clone:

```
claude plugin marketplace add ./claude-launch-agent
claude plugin install launch-agent@launch-agent
```

## Develop

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .   # run a session with the working copy, hot-reloading on save
```
