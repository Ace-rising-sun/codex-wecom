---
name: wecom-codex-setup
description: Configure WeCom Codex in the desktop plugin settings, or manage the local WeCom bridge and pairing.
---

# Configure WeCom Codex

The desktop path is Settings → Plugins → 企微 Codex → Settings. Select Open settings (打开设置) to configure the model, task time limit, access and robot in a dialog over the plugin details. Close the dialog to return to the details. Enter the robot Secret in the form's password field. If the user explicitly asks to open the form in chat and `wecom.settings.open` from `wecom-settings` is available, call it with `{}`. The terminal steps below support bridge management.

Use `runtime/manage.mjs` two directories above this skill. Run `node <absolute path to manage.mjs> status` first. If the bridge is already online and paired, report that status. If it is waiting for pairing, display the temporary pairing command from `manage.mjs pair`.

To set up a new bridge, run `node <absolute path to manage.mjs> setup` in an interactive macOS or Windows terminal. The setup asks for the long-connection robot's Bot ID and Secret and the local project directory. Enter the Secret at the hidden terminal prompt. Keep it out of the conversation, command arguments and repository files. The setup installs and starts its user-level background process.

Send the one-time pairing command in a direct message to the robot from the account that should control the selected project. After it acknowledges pairing, send `/ping`. Send a read-only task and a follow-up in the same chat to verify that the project and conversation are correct.

For completion reminders from Codex Desktop, review the plugin's Stop hook under Settings → Hooks. The helper reports completion events from the configured directory. Test the hook once with a real Desktop turn.

Use `manage.mjs stop` to stop background listening and `manage.mjs start` to restart it. Use `manage.mjs pair` to rotate the temporary code while pairing is pending. These commands use the existing local configuration.
