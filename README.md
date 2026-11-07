# Patchwork

Describe a code change once, pick the repositories it applies to, and get reviewed pull requests.

Patchwork is a SvelteKit UI (Tailwind, shadcn-svelte, Paraglide with English and Spanish) and
the Node **engine** that does the work: git, worktrees, the Claude agent, checks and pull requests.
It runs as a desktop app (Electron), a web app (a local server, or Docker) and later a mobile app
(Capacitor). The product plan and architecture are in [DESIGN.md](DESIGN.md).

> Run the commands below from the project folder (`~/ai-tool`).

## Ways to run it

| How                           | Command                        | Open                  | Local folders                                  |
| ----------------------------- | ------------------------------ | --------------------- | ---------------------------------------------- |
| **Desktop app** (development) | `npm run electron:dev`         | its own window        | Anywhere, with a native folder picker          |
| **Web app, local mode**       | `npm run server:local`         | http://localhost:3000 | In your home folder, with a folder browser     |
| **Web app in Docker**         | `docker compose up --build -d` | http://localhost:8080 | None by default: repositories are added by URL |
| UI development only           | `npm run dev`                  | http://localhost:5173 | Through the desktop or a server                |

### Desktop app

```sh
npm install
npm run electron:dev       # live reload for the UI
npm run electron:start     # the production build, unpackaged
npm run electron:package   # a standalone app in out/
npm run electron:make      # installers (zip, plus .deb on Linux or Squirrel on Windows)
npm run electron:make:win  # the Windows app from any system: a zip in out/make/zip/win32/
```

- **Restarting:** changes to `electron/` and `engine/` are rebuilt on save, but they only take
  effect after you restart the app.
- **Data:** stored in Electron's user-data folder, under `engine/`.
- **Agent login:** the agent uses your Claude login on this machine, unless an API key is saved
  in Settings.

### Web app, local mode

`npm run server:local` builds the app and runs the engine **directly on your machine**, the way
the desktop app does, and serves the web UI:

- **This machine only:** it listens on `127.0.0.1:3000`, so other devices can't reach it.
- **Local folders:** anything in your home folder can be added as a repository. **Browse…** on the
  Repositories page opens a folder browser that marks git repositories. Set
  `PATCHWORK_REPOS=/path/one:/path/two` to allow only those folders instead.
- **Data:** stored in `~/.patchwork/server`, separate from the desktop app's.
- **Agent login:** the agent uses your Claude login, like the desktop app.

### Web app in Docker

```sh
cp .env.example .env     # optional settings (tokens, port, commit author)
docker compose up --build -d
```

- **Isolated from your machine:** the container can't see your files. Repositories are added
  **by URL** and cloned into the private `/data` volume.
- **This machine only:** it listens on `127.0.0.1:8080`.
- **Sharing a folder anyway:** add the second compose file and set `REPOS_DIR` in `.env`:
  ```sh
  docker compose -f compose.yaml -f compose.local-repos.yaml up --build -d
  ```
  Everything in that folder becomes readable and writable by the agent, so share the narrowest
  folder that works.
- **Agent login:** the container can't use your Claude login. Set `ANTHROPIC_API_KEY` in `.env`,
  or save a key in Settings.
- **Commit author:** set `GIT_NAME` and `GIT_EMAIL`, otherwise publishing can't commit.
- **Updating:** after pulling or changing code, run `docker compose up --build -d` again.

### Mobile (Capacitor)

`npm run cap:android` opens Android Studio, and `npm run cap:ios` opens Xcode (macOS only). The
mobile app can't run git or the agent itself. Connecting it to a server (local mode or Docker,
with `PATCHWORK_TOKEN`) is the next planned step.

## Adding repositories

The Repositories page has two tabs. Wherever local folders are allowed, they come first.

- **Local folder:** pick a folder inside a git repository that has a remote.
  - On desktop, Browse… opens the native folder picker.
  - In the web app (local mode, or Docker with a shared folder), Browse… opens the engine's folder
    browser.
  - The app never deletes your folder.
- **From a URL:** `https://…`, `ssh://…` or `git@host:owner/name`.
  - Adding only **registers** the repository. A quick `git ls-remote` checks that it's reachable
    and finds its default branch, but nothing is downloaded yet.
  - The app clones it into its own data folder the **first time a change runs on it** ("Cloning…"
    in the task's activity log), or right away with **Clone now** on its card.
  - The card shows **Not cloned yet**, **Cloning…** or **Clone failed** (with git's message and a
    retry) until then.
  - Removing it deletes the app's copy, never the repository on GitHub or GitLab.
  - Private repositories clone with your GitHub sign-in or token, or a GitLab token.
- **Your GitHub repositories:** once you're signed in with GitHub, they're listed on the URL tab,
  and also **directly in New change**. Pick one, start the change, and it's added and cloned as
  the run starts. There's no separate add step.

## Working with the agent

Everything starts from **Agent** (under **Workflows** in the sidebar). By default the mode is
**Auto**: it follows what you write, and the button shows what it picked (e.g. "Auto: Review").

- A pull request link, or "review/check … PR #12", means a review.
- A question about the code ("can you explain …", "what does …", "how does …") means Ask.
- "Explore …", "How should we …", "What are the options for …" or "compare …" means an
  exploration.
- Anything else is a change.

Click a mode to set it yourself; it stays until you pick Auto again. The modes:

- **Change:** pick repositories (your GitHub repositories included) and describe the change. Each
  repository gets its own working copy and branch.
  - With one repository you can name the branch. Saved templates sit under the message box.
  - Talk to the agent from there. With several repositories, the **All repositories** tab sends a
    reply to every one, and a repository's own tab talks to just that one.
  - **Stop** halts the agent. **Review & publish** opens the run page with the diffs and pull
    requests.
- **Ask:** pick repositories and ask a question. The agent reads the code and answers in the
  conversation: no branch, no changes. Keep asking afterwards.
- **Review:** paste a GitHub pull request or GitLab merge request link (pasting one switches to
  Review), or pick an open one under **Pull request**.
  - Anything else you write goes to the agent as what to focus on. A link to a repository you
    haven't added yet adds it for you; it isn't cloned until the review runs.
  - Tick what to rate. Each attribute gets a 1–5 score and an explanation, plus an overall summary
    and verdict, shown as a card in the conversation.
  - The defaults are Correctness, Security, Minimalism, Readability, Tests and Performance. Edit
    them under **Settings → Reviews**, and add your own on each review.
  - **Post to GitHub/GitLab** posts the report as a review comment. It needs the same token as
    publishing.
- **Explore:** pick repositories and describe what you want to build. The agent compares 2–4
  approaches: files touched, pros and cons, effort, and a recommendation.
  - **Build this approach** starts a change with that approach, in a new conversation.

Questions, reviews and explorations never change your code. The agent works in a detached, read-only copy
where file edits are blocked, and the copy is removed when it finishes. You can keep asking
questions afterwards: each one gets a fresh copy, and the agent updates the report if its view
changed. An updated review can be posted again.

If the agent reports that it isn't signed in, it has no Anthropic credentials. The desktop app
and local mode can use your Claude login. Docker can't, so add an API key under **Settings → AI
agent**, or set `ANTHROPIC_API_KEY` before `docker compose up`.

Recent conversations are listed next to the chat. The old links (`/changes/new`, `/review`,
`/explore`) open the Agent in the matching mode.

## GitHub sign-in

"Sign in with GitHub" (Settings) uses a **GitHub App** that you register once:

1. Go to github.com → Settings → Developer settings → **GitHub Apps** → **New GitHub App**.
2. Fill in the form:
   - **Name:** anything.
   - **Homepage URL:** anything.
   - **Callback URL:** leave it empty.
   - **Expire user authorization tokens:** turn it **off**.
   - **Enable Device Flow:** turn it **on**.
   - **Webhook → Active:** turn it **off**.
3. **Repository permissions:** set **Contents** and **Pull requests** to _Read and write_.
4. Create the app, then use **Install App** to choose the repositories it may access.
5. Copy its **Client ID** (`Iv23…`) into Settings, or set `PATCHWORK_GITHUB_CLIENT_ID`.

Signing in shows a code: open GitHub, enter the code and approve. The app then opens pull
requests as you, and lists your repositories. A personal access token (Settings, or
`GITHUB_TOKEN`) still works as a fallback. GitLab uses a token (Settings, or `GITLAB_TOKEN`).

## Trying it safely: the sandbox

```sh
npm run electron:sandbox     # fake GitHub + dummy remote + the desktop app, all offline
npm run sandbox -- --reset   # start the sandbox over
```

- **The fake GitHub** (http://127.0.0.1:4010) has a sign-in page, pull request pages with Merge
  and Close buttons, and the demo repository `sandbox/demo`.
- **Pushes** land in `.sandbox/remote.git`. Nothing leaves your machine.
- **To try it:** sign in from Settings and approve the code on the fake GitHub's page. Then add
  `sandbox/demo` from the URL tab (or `.sandbox/demo` from Local folder), run a change, and open
  the pull request.

## Check and test

```sh
npm run check            # type check
npm run lint             # Prettier + ESLint
npm run test:unit        # Vitest: engine, server, UI state and component tests
npm run test:e2e         # Playwright in the browser, against real servers and a fake GitHub
npm run test:electron    # Playwright against the real Electron app
npm test                 # unit + e2e
```

- **No real services:** tests use a scripted agent (`PATCHWORK_TEST_AGENT=edit|hang`), a fake GitHub
  and fake GitLab (`dev/`), and local bare repositories as remotes. They never call a model,
  github.com or gitlab.com.
- **Hidden Electron windows:** the Electron tests run the app hidden and offscreen
  (`PATCHWORK_HIDE_WINDOW=1`), so no windows appear on the desktop.

## Settings for the server and Docker

| Variable                                                                           | Meaning                                                                              |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `PATCHWORK_LOCAL`                                                                  | `1` = local mode: home folder allowed, `127.0.0.1`, data in `~/.patchwork/server`    |
| `PATCHWORK_REPOS`                                                                  | Folders local repositories must be in (`:` or `,` separated); turns local folders on |
| `PATCHWORK_DATA_DIR`                                                               | Engine data: store, logs, worktrees, clones, saved keys                              |
| `PATCHWORK_TOKEN`                                                                  | Access token; required before opening the server to other machines                   |
| `PATCHWORK_ALLOWED_HOSTS`                                                          | Extra host names allowed without a token (e.g. a reverse proxy)                      |
| `PORT`, `HOST`                                                                     | Where the server listens (default `3000`, `0.0.0.0`; local mode `127.0.0.1`)         |
| `ANTHROPIC_API_KEY`                                                                | Key for the agent, unless one is saved in Settings                                   |
| `PATCHWORK_GITHUB_CLIENT_ID`                                                       | GitHub App client ID for "Sign in with GitHub"                                       |
| `GITHUB_TOKEN`, `GITLAB_TOKEN`                                                     | Tokens for pull requests and private clones, instead of signing in                   |
| `PATCHWORK_GITHUB_API_URL`, `PATCHWORK_GITHUB_WEB_URL`, `PATCHWORK_GITLAB_API_URL` | GitHub Enterprise, self-hosted GitLab, or the fake servers                           |
| `GIT_NAME`, `GIT_EMAIL`                                                            | Commit author in Docker (compose passes them to git)                                 |

The desktop app reads the same `PATCHWORK_GITHUB_*` and `PATCHWORK_GITLAB_API_URL` variables.

Patchwork was called "AI Tool" before. The old `AI_TOOL_*` names still work, and existing desktop and
local-mode data is moved to the new folders on first start.

## Conventions

- **Imports:** import from `src/lib` with `#lib/...`, SvelteKit 3's replacement for `$lib`.
  Import shadcn components by their full file path, for example
  `#lib/components/ui/button/index.js`.
- **Components:** all of shadcn-svelte's components are installed in `src/lib/components/ui/`. Use
  them before writing custom UI or CSS, for example `ScrollArea` for scrolling lists. Refresh them
  with `npx shadcn-svelte@latest add --all --yes --overwrite`.
- **Text:** all user-facing text goes in `messages/en.json` and `messages/es.json`. Use it as
  `m.key()` from `#lib/paraglide/messages.js`.
- **Links:** build them with `resolve(localizeHref(path))`, so they keep the current language.
- **No server code in SvelteKit:** the UI is a static app. Code that needs a machine goes in the
  engine, not in SvelteKit server routes.
- **New engine features:**
  1. Add the method to `src/lib/engine/contract.ts`.
  2. Implement it in `engine/`.
  3. Call it from the UI through the connection in `EngineGate`.

  Electron and the HTTP server pick it up with no extra wiring.

- **Theme:** dark by default. The Light/Dark/System switch is in the sidebar, and `app.html`
  applies the saved choice before the first paint.
