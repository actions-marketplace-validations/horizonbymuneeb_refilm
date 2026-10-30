---
name: Bug report
about: Something measured wrong, crashed, or exited with an unexpected code
title: ""
labels: bug
assignees: ""
---

<!--
The most useful bug report for refilm has three things: the exact command, its output, and what
you expected. If a capture is involved and you can share it (or the page HTML), that is the single
best attachment. "It doesn't match" cannot be reproduced; "verify exits 1 and names h1-opacity.duration"
can.
-->

## What happened

<!-- One or two sentences. -->

## The command

```bash
# paste the exact command, including every flag
```

## The output

<!--
Paste the terminal output, or better, the --json payload. If a command supports --json, that
payload is what makes a report actionable.
-->

```
```

## What you expected

<!--
For a wrong measurement, say which number you believe is wrong and what it should have been.
For a crash, say what the command should have done instead.
-->

## Exit code

<!-- `echo $?` right after the command. refilm's codes: 0 ok, 1 verification failed, 2 usage, 3 environment, 4 internal. -->

```
```

## Reproduction material

<!-- Tick what you can share. The more the better; a capture directory is ideal. -->

- [ ] the page HTML (or the URL, if it is public)
- [ ] the capture directory (`capture.json`, `inspect.json`, `track.json`, frames)
- [ ] the `spec.json` and the clone's capture
- [ ] a screenshot or screen recording
- [ ] nothing — the command alone reproduces it

## Environment

<!-- `refilm doctor --json` covers all of this in one command. -->

```
refilm doctor --json
```

- refilm version:
- Node version:
- OS:
- ffmpeg version:
- capture settings (`--clock`, `--gpu`, `--fps`, viewport):

## Anything else

<!--
Workarounds you found, whether it used to work, which version — anything that narrows it down.
-->
