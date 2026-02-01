# Solobot Command Cheatsheet

> **Note**: These commands assume you have set up the `solobot` alias in your
> `~/.bashrc`. If you haven't, run the alias setup command in the **Setup
> Alias** section first.

## Setup Alias (Required)

Run this once on your Coolify server to enable the `solobot` command:

```bash
echo 'solobot() { sudo docker exec -it $(sudo docker ps -q --filter name=moltbot) node dist/index.js "$@"; }' >> ~/.bashrc
source ~/.bashrc
```

_(You can also use `openclaw` or `clawdbot` as aliases if you prefer, they map
to the same container)_

---

## 1. Essentials (Start Here)

| Command                   | Description                                                                                   |
| :------------------------ | :-------------------------------------------------------------------------------------------- |
| `solobot status`          | Show current status of the gateway, AI, and connections.                                      |
| `solobot onboard`         | **Interactive Wizard** to set up the gateway, workspace, and skills.                          |
| `solobot doctor --fix`    | **Auto-fix common issues** (permissions, config, tokens). Run this first if something breaks. |
| `solobot logs`            | View real-time logs from the gateway.                                                         |
| `solobot help`            | Show all available commands.                                                                  |

## 2. Artificial Intelligence & Agents

Manage the brains behind the bot and run agent tasks.

| Command                               | Description                                                                     |
| :------------------------------------ | :------------------------------------------------------------------------------ |
| `solobot agent --message "..."`       | Run a single agent turn/command directly.                                       |
| `solobot agents list`                 | List active AI agents.                                                          |
| `solobot agents add`                  | Add a new isolated agent workspace.                                             |
| `solobot agents set-identity`         | Customize an agent's name, emoji, and avatar.                                   |
| `solobot models list`                 | List currently configured models.                                               |
| `solobot models set <model_id>`       | Switch the default model (e.g., `solobot models set claude-3-5-sonnet-latest`). |
| `solobot models scan`                 | Scan for new free/paid models from OpenRouter.                                  |
| `solobot memory status`               | Check the status of the AI's long-term memory (Vector DB).                      |

## 3. Configuration

| Command                 | Description                                    |
| :---------------------- | :--------------------------------------------- |
| `solobot configure`     | **Interactive setup** for credentials and keys.|
| `solobot config edit`   | Manually edit the configuration (JSON).        |
| `solobot config view`   | View the current configuration.                |
| `solobot security`      | Manage security tokens and API keys.           |
| `solobot update`        | Check for and apply CLI updates.               |

## 4. Connectivity & Pairing

Connect your bot to the world (Telegram, WhatsApp, etc).

| Command                                   | Description                                                 |
| :---------------------------------------- | :---------------------------------------------------------- |
| `solobot devices list`                    | **Show pending device links** & control UI access requests. |
| `solobot devices approve <id>`            | Approve a pending device/browser request.                   |
| `solobot pairing list telegram`           | List pending Telegram pairing codes.                        |
| `solobot pairing approve telegram <code>` | Approve a Telegram bot pairing request.                     |
| `solobot gateway status`                  | Detailed status of the message gateway.                     |
| `solobot channels list`                   | List active communication channels.                         |
| `solobot dashboard`                       | Get the URL for the Web Control UI.                         |

## 5. Messaging & Interaction

Send messages and interact with users directly.

| Command                                    | Description                                           |
| :----------------------------------------- | :---------------------------------------------------- |
| `solobot message send --to <id> -m "..."` | Send a direct message to a user or channel.           |
| `solobot message poll`                     | Create a poll in supported channels (Discord/Telegram)|
| `solobot message react`                    | React to a specific message ID with an emoji.         |
| `solobot message pin`                      | Pin a message in a channel.                           |

## 6. Advanced & System

| Command                | Description                                            |
| :--------------------- | :----------------------------------------------------- |
| `solobot system`       | View system health and heartbeat events.               |
| `solobot cron list`    | List scheduled background tasks.                       |
| `solobot plugins list` | Manage installed plugins.                              |
| `solobot sandbox`      | Manage the code execution sandbox (Docker/Bubblewrap). |
| `solobot uninstall`    | Clean up and uninstall the service (use with caution). |

## Troubleshooting Examples

**"I can't connect to the Web UI"**

```bash
solobot devices list
# Find your request ID in the list
solobot devices approve <request-id>
```

**"The bot isn't replying"**

```bash
solobot logs
# Check for errors. If it looks stuck:
sudo docker restart $(sudo docker ps -q --filter name=moltbot)
```

**"Permissions errors in logs"**

```bash
solobot doctor --fix
```
