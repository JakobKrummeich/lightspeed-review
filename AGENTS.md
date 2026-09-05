# AGENTS.md — lightspeed

## Setting lightspeed up in a repository

If you were pointed at a fresh clone and asked to set lightspeed up, the
copy-pasteable instructions are the **For agents** section of `README.md`.
The short version is two jobs, not one: `lightspeed init --config` scaffolds the
config this repository needs, and `lightspeed init --agent <id>` writes the skill
you need — only if you do not have one already. If you wrote a skill, ask to be
restarted: skills are scanned at agent startup, so it is invisible to you
until then.
