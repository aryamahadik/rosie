# Working in this repository (every agent)

- Read files, including memory files, with the Read, Glob and Grep tools, never with Bash loops or `cd` into other folders.
- In Bash, run only commands that `.claude/settings.json` allows; anything else is denied, and a denied command is never tried another way: report it as a NEED (build prompt 5.6).
- Never open, print or log `.env`, `.dev.vars` or any key.
