# Submission preparation — 0.1.1

Source repository: `https://github.com/echelong/cobalt-cockpit`.
Plugin folder: repository root. Version: `0.1.1`. Planned GitHub release tag: `v0.1.1`.
Name: Cobalt Cockpit. Identifier: `cobalt-cockpit`. License: MIT.
Use the manifest description as the listing description.

The repository includes a self-hosted marketplace named `cobalt-cockpit` for GitHub installs. Its root-relative `./` source installs this plugin; function commands are registered by the hooks module, not Markdown commands. Four bundled agents inherit users' model choices. There are no MCP servers, credentials, package launchers or extra permission grants.

Checked against Claude Code 2.1.288 and the current [mod documentation](https://code.claude.com/docs/en/plugins/mods/overview), [manifest schema](https://code.claude.com/docs/en/plugins-reference), [publishing guide](https://code.claude.com/docs/en/plugins/publish) and [pre-submission checklist](https://claude.com/docs/plugins/pre-submission-checklist).

After publication and explicit owner approval, use [the developer portal](https://claude.ai/directory/manage) to validate the published source and submit the plugin bundle. The portal validates additional rules and name availability; local validation cannot certify acceptance. The official `claude-plugins-official` marketplace does not take submissions through this portal; its listing route requires an Anthropic partner contact.

This is a Claude Code mod. Its HUD and function commands do not run in claude.ai or Cowork. Two synthesized WAV cues are bundled binary files, so the checklist indicates a likely manual-review hold. Explain their source (`assets/sounds/make-sounds.py`) and audio fallback during review. No submission has been made.
