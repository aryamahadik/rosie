# Working in this repository (every agent)

- Read files, including memory files, with the Read tool. The Glob and Grep tools may not exist (Claude Code 2.1.319 has neither): list a folder with Bash `ls <folder>`. Never use Bash loops or `cd` into other folders.
- In Bash, run only commands that `.claude/settings.json` allows; anything else is denied, and a denied command is never tried another way: report it as a NEED (build prompt 5.6).
- Write every Bash command plainly, one command per call: no backslash escapes, no `$(...)` or backticks, no pipes, `;`, `&&`, redirection or loops. Put a value with spaces in quotes: `git log --format='%h %s'`, never `git log --format=%h\ %s`. An unattended shift refuses the escaped form even when the command itself is allowed (D-000 check 3, attempt 4).
- Never open, print or log `.env`, `.dev.vars` or any key.
