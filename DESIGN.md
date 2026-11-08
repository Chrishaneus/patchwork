# Patchwork

Describe a code change once, pick the git repositories it applies to, and get a reviewed pull
request in each one.

This document is the plan. Section 8 shows what's built so far. Development commands for the app
are in [README.md](README.md).

---

## 1. What it does

1. **Save repositories.** You add local folders. The app checks that each one is a git repository
   with a remote it can push to, then remembers it.
2. **Describe a change.** You select one or more saved repositories and write what should change,
   for example "Upgrade eslint to v10 and fix the new lint errors". You can set the base branch,
   the new branch name and whether the PR is a draft.
3. **AI makes the change.** For each repository the app creates an isolated working copy on a new
   branch. It then runs an AI coding agent there with your instructions, and you watch its
   progress live.
4. **Review.** You see the diff and the agent's summary for each repository. You can approve it,
   ask for follow-up changes or discard it.
5. **Open PRs.** For approved repositories the app commits, pushes the branch and opens a pull
   request. The PR links show up in the run.

Two read-only workflows sit next to it:

- **Review PR.** Rate any pull request or merge request on chosen attributes (1–5, each with an
  explanation), then optionally post the report as a comment.
- **Explore.** Compare approaches to an idea before building one.

Nothing is pushed until you approve it.

## 2. Architecture

The app has two parts: a UI that looks the same everywhere, and an engine that does the real
work.

```
┌──────────────────────────── UI (src) ───────────────────────────────────┐
│ SvelteKit SPA · Tailwind · shadcn-svelte · Paraglide (en, es)           │
│ Pages call an EngineClient interface and never touch git or files.      │
└───────────────┬─────────────────────────────────────┬───────────────────┘
                │ Electron IPC (preload bridge)       │ HTTP + server-sent events
┌───────────────▼──────────────┐      ┌───────────────▼──────────────────┐
│ Desktop: Electron main       │      │ Server: Node HTTP server         │
│ process runs the engine      │      │ runs the engine, serves the UI   │
│ in-process                   │      │ (Docker, repos mounted in)       │
└───────────────┬──────────────┘      └───────────────┬──────────────────┘
                └──────────────┬──────────────────────┘
                     ┌─────────▼──────────┐
                     │ engine (TS, Node)  │  git · worktrees · AI agent ·
                     │ shared package     │  commits · push · PRs · storage
                     └────────────────────┘
```

### Why the UI is a static app

"Static" only means the UI is built into plain HTML/JS/CSS files with no server rendering. The UI
can still use any JavaScript in the browser: interactive components, state, client-side
libraries, calls to APIs. Capacitor and Electron need it this way, because both load the UI from
files packaged with the app.

Code that needs a machine (reading folders, running git, calling the AI with your keys) does not
go into SvelteKit server routes. They would only run in the Docker build, and desktop and mobile
would lose them. That code lives in a shared **engine** package instead, with two ways to reach
it:

| Target                   | How the UI reaches the engine         | Where repositories live                         |
| ------------------------ | ------------------------------------- | ----------------------------------------------- |
| Desktop (Electron)       | IPC through `electron/preload.ts`     | Your local disk                                 |
| Web (Docker)             | HTTP API on the same Node server      | Folders mounted into the container              |
| Mobile (Capacitor)       | HTTP API of a server you host (later) | On that server, since phones can't run git here |
| Plain browser, no server | None: pages explain they need desktop | n/a                                             |

### How the engine is shared (built in M1)

Every host speaks the same small protocol, so adding a host is a transport, not a rewrite:

- **Contract:** [`src/lib/engine/contract.ts`](src/lib/engine/contract.ts) lists
  every engine method (`EngineApi`), the shared data types and the error codes. It is plain JSON
  types with no Node or browser imports, and both the UI and the engine import it.
- **Engine:** [`engine/`](engine/) implements `EngineApi` in Node.
  `handleEngineCall(engine, method, input)` is the single entry point every host calls. It checks
  the method name and input, and turns errors into `{ ok: false, error: { code, message } }`.
- **Transport:** each host passes `(method, input)` through one channel, plus one push channel
  for live `EngineEvent`s (task updates and log lines):
  - Electron: the IPC channels `engine:invoke` (calls, only accepted from the app's own pages) and
    `engine:event` (pushed to every window).
  - Server ([`server/`](server/), built in M3): `POST /api/engine/:method` and
    server-sent events on `GET /api/events`. The client reads the event stream with `fetch`, so the
    access token can go in a header. It reconnects with backoff and sends a `resync` event, so the
    UI reloads what it may have missed.
  - The client always sends plain JSON. Svelte's reactive proxies can't cross IPC or HTTP.
- **Client:** `createEngineClient(transport)` in
  [`src/lib/engine/client.ts`](src/lib/engine/client.ts) turns any transport into
  typed calls. `connectEngine()` tries Electron first, then the server the page was loaded from
  (`/api/health`). The result is connected, needs a token, or unavailable. Pages wrap their
  content in `EngineGate`, which shows a loading state, the token form, or an "unavailable"
  notice, so each page only deals with the connected case.
- **Host features:** abilities that depend on the platform, such as the native folder picker, are
  separate optional `HostCapabilities`. Without them the UI falls back to a path field, which
  also works against a server.
- **Adding a feature:** add one method to the contract and implement it in the engine. Then call
  it from the UI. Electron, and later the server, pick it up with no new wiring.

**Server security** (M3):

- **Without `PATCHWORK_TOKEN`:** the server only answers requests addressed to `localhost`, which
  blocks other machines and DNS-rebinding tricks. Docker publishes the port on `127.0.0.1` by
  default.
- **With a token:** every API call needs `Authorization: Bearer <token>`, and other hosts and
  origins (for example the mobile app) are allowed. The UI asks for the token and remembers it on
  that device.
- **Cross-site requests:** engine calls must be `application/json`, so a browser on another
  website has to send a preflight request first, and the server refuses that without a token.
- **Repository folders:** by default the server has no local folders at all: repositories are
  added by URL and cloned into `/data`. With `compose.local-repos.yaml`, a host folder is mounted
  at `/repos` (`PATCHWORK_REPOS`). The engine then also accepts local repositories inside it, and
  the Repositories page lists the ones it finds there.

### Folder layout

```
ai-tool/
├── DESIGN.md              ← this plan
├── README.md              ← how to run, test and configure the app
├── src/               ← UI (SvelteKit)
│   └── lib/engine/    ← contract.ts (shared types), client.ts (typed client + transports)
├── engine/            ← Node engine (no Electron or HTTP imports)
│   ├── index.ts       ← createEngine + handleEngineCall
│   ├── core/          ← store (SQLite), events, task logs, secrets, legacy env names
│   ├── git/           ← git runner and remote URL parsing, worktrees and diffs, commit and push
│   ├── repositories/  ← validate, add, clone, check, remove repositories; folder browsing
│   ├── runs/          ← queue, task lifecycle, cancel/timeout, checks, publish, discard;
│   │                    review/explore/ask prompts and parsing (workflows.ts)
│   ├── settings/      ← Settings page values, saved credentials, instruction templates
│   ├── agent/         ← Claude Code and Codex runners, sandbox, tool policy, classifier, test agent
│   └── providers/     ← GitHub and GitLab APIs, GitHub sign-in; index.ts picks the provider,
│                        token and HTTPS push auth
├── electron/          ← main.ts, preload.ts (bundled by esbuild to dist-electron/)
├── server/            ← Node HTTP server for Docker and mobile      (M3, built)
├── dev/               ← fake GitHub + sandbox for trying publishing (M4, built)
├── android/ ios/      ← Capacitor projects
└── Dockerfile, compose.yaml
```

## 3. Core flow in detail

### Adding a repository

There are two ways, and which ones are available depends on where the app runs:

|                  | Desktop app                               | Web app (server / Docker)                                                                                                                        |
| ---------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Local folder** | Default tab: native folder picker or path | **Local mode** (`npm run server:local`): your home folder, with a folder browser. **Docker**: only a mounted folder (`compose.local-repos.yaml`) |
| **From a URL**   | Yes                                       | Yes, the default; the only way when nothing is mounted                                                                                           |

- **Local folder:** the app validates the folder. It must be inside a git repository with a
  remote, and the app records the provider, `owner/name` and default branch. The app never
  deletes your folder.
- **From a URL** (`https://`, `ssh://` or `git@host:owner/name`):
  - **Clone on demand:** adding only registers the repository. `git ls-remote` checks access and
    finds the default branch.
  - The clone into the app's data folder (`<data>/clones/<host>/<owner>/<name>`, marked "App
    copy") happens when a change first runs on it, as part of preparing the task, or with
    "Clone now".
  - Simultaneous requests share one clone. A failed clone marks the repository and fails the
    task, and can be retried.
  - Private repositories clone with your GitHub sign-in or token (or GitLab token), sent as HTTPS
    credentials through `GIT_CONFIG_*`. The token never appears in logs.
  - Removing the repository deletes the app's copy.
  - On a server, `file://` URLs and local paths are refused unless local folders are enabled, so
    a URL can't be used to read files on the server.
- **Your GitHub repositories:** when you're signed in with GitHub, they're listed on the URL tab
  and directly in New change's picker. A repository picked there is registered when the run starts
  and cloned as its first task prepares.
- **Repositories page:** shows the current branch, uncommitted changes and the remote for each
  repository. "Re-check" validates again.

### GitHub sign-in

- "Sign in with GitHub" in Settings uses the OAuth **device flow** of a **GitHub App**:
  1. The app shows a code.
  2. You open github.com/login/device, enter it and approve.
  3. The app polls GitHub and stores the token like other secrets.
- Only the app's **client ID** is needed, not a client secret, so it works the same on desktop,
  on a server and later on phones. The client ID is set in Settings or with
  `PATCHWORK_GITHUB_CLIENT_ID`.
- **Token order:** the sign-in token comes first, then a saved token, then `GITHUB_TOKEN`. The
  personal access token field stays as a fallback.
- **Expiring tokens:** turn "Expire user authorization tokens" off in the GitHub App, because
  renewing an expiring token needs the client secret. If a token does expire, the app signs you
  out and asks you to sign in again.
- **Testing:** the fake GitHub implements the device flow, with an approval page, so the sandbox
  and the tests never touch github.com.

### Running a change ("run")

A run is one instruction applied to N repositories. Each repository gets its own **task**.

For each task, at most 2–3 run at the same time (configurable):

1. **Prepare.** `git fetch`, then `git worktree add <app-data>/worktrees/<taskId> -b <branch>
origin/<base>`. Worktrees leave your own checkout and any uncommitted work untouched, and
   several tasks can share one repository safely.
2. **Run the agent** with the worktree as its working directory (see section 4). Its events
   (messages, tool calls, files changed) are streamed to the UI.
3. **Collect the result:** `git diff --stat` and the full diff against the base, plus the agent's
   final summary.
4. **Review:** the task waits for you. You can:
   - **approve**, which goes to step 5;
   - **ask for changes**, which re-runs the agent in the same worktree with your follow-up;
   - **discard**, which removes the worktree and branch.
5. **Publish:**
   - Commit with a generated message that you can edit.
   - `git push -u origin <branch>`.
   - Open the PR with the title and body taken from the agent's summary, and save the PR URL.
6. **Clean up:** remove the worktree once the task is published or discarded.

Task states: `queued → preparing → running → awaiting_review → publishing → done`, or `failed` /
`cancelled` / `discarded`. M2 has everything up to `awaiting_review`, plus failed, cancelled and
discarded.

Details as built in M2:

- **Fetch:** if fetching fails (offline, no access), the task carries on from the local copy of
  the base branch and says so in the log.
- **Cancel:** a cancelled task keeps its worktree, so you can look at the partial work or discard
  it.
- **Time limit:** the agent is stopped after the limit set in Settings (default 30 minutes), and
  the task fails with a `timeout` error.
- **App closed mid-run:** tasks that were running are marked `interrupted` on the next start. They
  can't resume.
- **Diff:** taken against the commit the branch started from. It includes new files, and commits
  the agent made despite being asked not to.
- **Logs:** written to one append-only file per task, so they survive a restart.

Built in M5:

- **Checks:** each repository can have a **check command**, for example
  `npm ci && npm test`, set on its card on the Repositories page.
  - After the agent finishes, the task moves to `checking` and the command runs in the worktree
    through the shell, with `CI=true`.
  - The result is pass or fail, with the exit code and the end of the output (16 KB). Failing
    checks still leave the task in review: you decide.
  - The command gets no app secrets (`ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `GH_TOKEN`,
    `PATCHWORK_TOKEN`).
  - Cancel and the time limit kill the whole process tree.
  - "Run checks again" re-runs the command on a task in review, for example after you fix it.
  - Worktrees start without installed dependencies, so include the install step in the command
    when the checks need it.
- **Follow-ups** (M6): a change in review, or a failed or cancelled one that still has its working
  copy, can get more instructions.
  - The agent continues in the same working copy, and its prompt includes the original request,
    earlier follow-ups, its last summary and, if checks failed, the end of their output.
  - The diff, cost and turns cover the whole change, and the new summary describes it all.
  - "Fix failing checks" sends a ready-made instruction to make the checks pass without weakening
    them.
- **Concurrency:** "Tasks at the same time" in Settings (1–8, default 2). Changing it starts
  queued tasks right away.
- **Publish all ready:** a run-level dialog lists the tasks in review with their checks status.
  - It preselects the ones whose checks passed, and you can change the selection.
  - It publishes them one by one, with one shared title and each task's own summary, and shows
    the result for each.

## 4. AI agent

Built in M2 ([`engine/agent/claude/`](engine/agent/claude/index.ts)). Each agent has its own folder
(`claude/`, `codex/`); [`runner.ts`](engine/agent/runner.ts) holds what they share: the
`AgentRunner` interface and the guidance both agents are given.

- **SDK:** the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`), which is Claude Code
  packaged as a library. It runs as a native per-platform binary started by the engine process.
  Docs: https://code.claude.com/docs/en/agent-sdk.
- **Model:** `claude-opus-5-5` by default, changeable in Settings. Picking an OpenAI model runs
  Codex instead (see **Codex** below).
- **Options used:**
  - `cwd` = the worktree;
  - `permissionMode: 'default'`, with `canUseTool` running our policy;
  - the `claude_code` system prompt plus our guidance;
  - `settingSources: ['project']`, which loads the repository's own `CLAUDE.md` and project
    settings but not this machine's user settings;
  - `attribution` turned off, so there are no "Generated with" footers;
  - an `AbortController` for cancel and the time limit.
- **Guardrails** ([`agent/policy.ts`](engine/agent/policy.ts)):
  - File edits are allowed only inside the worktree.
  - Shell commands are allowed, except `git push`, changing remotes, `git worktree` and
    `gh pr/release/repo/api`.
  - Blocked calls show up in the log.
  - These checks are a safety net, not a boundary: `git -C . push` or `sh -c "git pu""sh"` get
    past regexes. The boundary is the sandbox below, plus giving the agent no credentials.
- **Sandbox** ([`agent/sandbox.ts`](engine/agent/sandbox.ts)): Claude Code's own (bubblewrap
  and socat on Linux, Seatbelt on macOS), for every shell command:
  - writes only in the worktree and its git folder;
  - network only to package registries (`PACKAGE_REGISTRIES`), strictly; GitHub and GitLab are
    not on the list, so a token couldn't be used even if one leaked;
  - the app's tokens and the Anthropic key are withheld from the environment, and SSH keys, git
    and CLI credentials and the app's `secrets.json` are unreadable. `credentialFiles` finds them
    where each tool keeps them per platform (`%APPDATA%`, Application Support, `XDG_CONFIG_HOME`,
    `GH_CONFIG_DIR` and the like). Under WSL the Windows profiles in `/mnt/c/Users` are covered
    too; Windows programs can't be started from inside the sandbox (WSL interop needs a socket
    it blocks), and the Windows drives are read-only;
  - no way out: `allowUnsandboxedCommands: false`, and Bash still goes through the policy.
  - `sandboxSupport` checks for the tools and that bubblewrap may create namespaces. Where it
    can't run (Windows, missing tools, Docker without `seccomp=unconfined`), commands run
    unsandboxed with a note in the task log and in Settings.
  - The rules are agent-neutral: `sandboxPolicy` returns the writable folders (none for the
    read-only workflows), allowed hosts, denied files and denied environment variables, and each
    runner enforces them its own way. Claude Code's sandbox always lets commands write in the
    working directory, so read-only workflows also put it in `denyWrite`.
  - Read-only workflows: besides the denied file tools and the sandbox, their copy is made
    read-only on disk (`setWritable` in `git/worktrees.ts`) for agents whose commands can't be
    sandboxed here. That stops `sed -i`, `rm` or `> file`, but a command could change the
    permissions back, so only the sandbox makes it a boundary. `removeWorktreeOnly` makes the
    copy writable again before removing it. `claudeSandbox` (in `claude/`) turns them into the SDK's
    `sandbox` option, `codexSandbox` into Codex's (below). A future agent without a usable
    sandbox could run whole inside `@anthropic-ai/sandbox-runtime` (`srt`) with the same policy.
- **Running a command outside the sandbox:** when a task can't do something inside the sandbox
  (say, start a database container), the agent may ask to run that one command outside it.
  Runners get `requestApproval({ command, reason })` and turn their agent's own prompt into it;
  the engine ([`runs/approvals.ts`](engine/runs/approvals.ts)) shows it as `task.approval`, waits
  for `answerApproval` (a cancel or the time limit counts as no) and logs the answer. "Always"
  saves the program on the repository (`allowedPrograms`); `programOf`
  ([`agent/approvals.ts`](engine/agent/approvals.ts)) never offers it for shells, interpreters or
  chained commands, which could run anything. Claude Code asks through
  `allowUnsandboxedCommands` (a Bash call with `dangerouslyDisableSandbox` goes to `canUseTool`),
  Codex through app-server's `item/commandExecution/requestApproval`.
- **Codex** ([`agent/codex/`](engine/agent/codex/index.ts)): OpenAI models run in Codex's
  app-server (`codex app-server`, JSON-RPC over stdio, [`app-server.ts`](engine/agent/codex/app-server.ts)),
  one process per run, from the binary in `@openai/codex`. The earlier runner through
  `@openai/codex-sdk` (`codex exec`, which can't ask for approvals) is kept for reference in
  [`codex/sdk.ts`](engine/agent/codex/sdk.ts); nothing uses it. `createAgentRunner`
  ([`agent/agents.ts`](engine/agent/agents.ts)) picks the agent from the model's provider
  (`providerOf` in `src/lib/engine/models.ts`; custom IDs starting `gpt-`, `o<digit>` or `codex` go to
  Codex).
  - Sandbox: a permissions profile (`default_permissions`) that reads everything but the denied
    files and writes only the writable folders; network through Codex's proxy
    (`features.network_proxy`, still experimental) with the registries as the only allowed
    domains; `shell_environment_policy` filters the denied variables out of every command. Codex
    sandboxes on Linux (a bundled bubblewrap), macOS and Windows itself, so `sandboxSupport`
    doesn't apply; `codexSandboxSupport` runs one command under a profile like a task's.
  - Windows: only MXC (Windows 11 24H2+, no admin) and the elevated sandbox can deny reads, so
    the overrides set `features.prefer_mxc` with `windows.sandbox="elevated"` as the fallback,
    and `allow_local_binding` for MXC's proxy. When the probe fails there, Settings offers
    `setUpAgentSandbox`, which runs `codex sandbox setup --elevated --current-user` (UAC).
  - No per-tool hook, so `policy.ts` doesn't run: the sandbox is the whole boundary. Read-only
    workflows get no writable folders. The approval policy is `on-request` when someone can
    answer (Codex asks before running a command outside the sandbox), else `never`; every other
    request that would widen the sandbox (file changes, permissions, network hosts) is declined.
  - Our guidance goes in the thread's `developerInstructions`; threads are ephemeral, so runs
    don't show up in the user's Codex history. Codex reads the repository's `AGENTS.md`
    itself. Commands are logged when they start, because a failed one may never be reported as
    completed. Codex reports tokens, not dollars, so cost and turns are left empty.
  - Credentials: a key saved in Settings, then `OPENAI_API_KEY`, then the machine's
    `codex login` (`~/.codex/auth.json`, which the sandbox denies to both agents). app-server
    ignores key variables and logging in through it would replace the user's login, so a key
    goes in `PATCHWORK_OPENAI_API_KEY` with a model provider that reads it (`env_key`); commands
    never see it.
  - Verified with a real run (`gpt-6-luna`, ChatGPT login): it fixed a bug in a worktree, the
    app's `secrets.json` was unreadable, GitHub was refused by the proxy, and in an explore run
    the worktree was read-only.
  - The Auto-mode classifier stays a small Claude model; without Claude credentials it falls
    back to the keyword rules.
- **Prompt:**
  - Your instruction, plus the repository and branch.
  - Asks the agent to follow the repository's conventions and run its checks, not to commit or
    push, and to end with a Markdown summary, which becomes the PR description.
- **Log:** each tool call becomes one short line (`$ npm test`, `Edit src/a.ts`), and the agent's
  text is shown as written. The task records cost and number of turns from the SDK's result.
- **Credentials:**
  - A key saved in Settings wins over `ANTHROPIC_API_KEY`.
  - With neither, the agent uses the Claude login on the machine, if there is one.
- **Tests and cost:** engine and end-to-end tests use fake agents, so they never call the model.
  A real run of a one-file change costs about $0.10.

## 5. Git provider and PRs

Built in M4:

- **Publishing a task** (`publishTask`, from the review screen):
  1. Commit everything in the worktree, on top of anything the agent already committed. The PR
     title is the commit subject and the description is its body. The repository's own commit
     hooks run.
  2. Push the branch to the repository's remote.
  3. On GitHub, open the pull request (optionally as a draft). If one already exists for the
     branch, it's reused.
  4. Remove the worktree and keep the branch. The diff stays available, taken from the
     repository.
- **Remote URL:** the engine reads the remote URL as configured, so `url.*.insteadOf` rewrites
  don't hide that a remote is GitHub.
- **Other remotes:** branches are pushed, and the UI says to open the PR on your git host.
- **Failures:**
  - A failure at any step keeps the task in review with `publishError`, and "Try again" finishes
    the job. It won't make a second commit or a duplicate PR.
  - A missing GitHub token stops publishing before git is touched.
  - An empty change is refused.
- **GitHub token:** from Settings, or `GITHUB_TOKEN` / `GH_TOKEN`. It needs fine-grained
  "Contents" and "Pull requests" read and write access.
  - It's also used to push over HTTPS to `github.com`, which Docker needs because the container
    has no other credentials. The token is passed through `GIT_CONFIG_*` environment variables,
    so it never appears in a command line, an error message or a log.
  - SSH remotes use your SSH setup as before.
- **Commit author:** your git `user.name` and `user.email`. In Docker, set `GIT_NAME` and
  `GIT_EMAIL`.
- **GitHub API:** `PATCHWORK_GITHUB_API_URL` points the app at GitHub Enterprise, or at the local
  fake GitHub.
- **Trying it safely:** `npm run sandbox` creates `.sandbox/` and starts a fake GitHub on
  `127.0.0.1:4010`. Its PR pages have Merge and Close buttons, so you can try the status sync.
  - `remote.git` is a bare repository that plays the remote.
  - `demo/` is a small JavaScript project whose remote is `https://github.com/sandbox/demo.git`,
    rewritten to the bare repository.
  - The fake GitHub shows each PR and its diff. `npm run electron:sandbox` starts it together
    with the app.
- **GitLab** (M6): merge requests through GitLab's REST API, using a token from Settings or
  `GITLAB_TOKEN` (needs the api scope).
  - Projects are addressed by their path, so subgroups work.
  - Drafts use the `Draft:` title prefix.
  - An existing open MR for the branch is reused.
  - HTTPS pushes send the token as `oauth2:<token>`.
  - The API is `https://<remote host>/api/v4` (self-hosted works too), or
    `PATCHWORK_GITLAB_API_URL`.
- **PR status sync** (M6): the state of open PRs and MRs (open, merged, closed) is read from
  their provider every 5 minutes in the background, and on demand with "Refresh PR status" on the
  Runs page. The dashboard counts open ones only.
- **Later:**
  - a `gh` CLI fallback, so no token needs to be stored;
  - Bitbucket, behind the same provider layer.

## 6. Storage and secrets

- **Data:** repositories, runs (with their tasks), templates and settings in SQLite
  (`patchwork.db`, through Node's built-in `node:sqlite`, so there's no native module to build
  for Electron), [`core/store.ts`](engine/core/store.ts):
  - in Electron's `app.getPath('userData')` on desktop;
  - in a `/data` volume in Docker.
  - One row per repository, run and template, each as JSON, plus the settings. The engine
    still sees the whole data in memory and changes it in `store.update`. Only the rows that
    differ from what's on disk are written, in one transaction. A change that names the rows it
    changed (`touch`, used by `updateTask`, the most frequent one) skips comparing the rest. With
    3,000 runs (10 MB), a task update takes about 1 ms to save instead of rewriting the whole
    file (about 70 ms).
  - A `data.json` from before the database is imported on first start and kept as
    `data.json.imported`.
  - Damaged data doesn't stop the app. Each start with a healthy database saves a copy
    (`patchwork.db.bak`, through SQLite's backup API). If the database is damaged at start
    (SQLite error 11 or 26, or `PRAGMA quick_check` fails), it's renamed to
    `patchwork.db.corrupt-<time>` and the copy is used, or else the app starts empty. A damaged
    `data.json` is set aside the same way. Rows that can't be parsed are left out but stay in
    the database. Other errors, such as a locked or unreadable file, still stop the engine, so
    nothing is moved aside by mistake. What happened is in `getEngineInfo().dataRecovery`, and
    every page shows it until dismissed.
  - Migrations: `meta.version` says what shape the data has. `MIGRATIONS` in `core/store.ts` is
    a numbered list of steps (`to: 2`, `3`, …). Each changes the data in place (`data`) and,
    when needed, the tables (`db`). At start, the steps newer than the saved version run on the
    data as it was saved, and the result and the new version are written in one transaction.
    Before that, the database is copied as `patchwork.db.v<old version>.bak`. An imported
    `data.json` goes through the same steps. Data from a newer Patchwork (a higher version)
    stops the engine with `data_too_new` rather than being changed. Add a step before changing
    the shape of anything saved. There are none yet, so the version is 1.
  - Runs are still never pruned, and all of them are loaded into memory.
- **Secrets** (API keys, tokens), behind a `SecretStore` interface each host implements:
  - Desktop: one file in the app's data folder, readable only by your user. Secrets are encrypted
    with Electron `safeStorage` when the system has a keychain. On systems without one (WSL, bare
    Linux desktops) they are stored as plain text, like the GitHub and Claude CLIs do, and Settings
    says so.
  - Server: `ANTHROPIC_API_KEY` from the environment, or a key saved in Settings. The key is kept
    in a file in the private `/data` volume, readable only by the server's user, not encrypted, and
    the Settings page says so.
  - Secrets are never sent to the UI after they are saved.

## 7. UI

| Page                         | Purpose                                                                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Dashboard**                | Counts (repos, active runs, open PRs), recent runs, getting started                                                                |
| **Repositories**             | List, add (folder picker), re-check, remove; branch, remote and status shown for each                                              |
| **New change**               | Choose repositories (multi-select with search), instructions, base branch, branch name, draft PR toggle, start                     |
| **Runs** / **Runs › detail** | List of runs; for each run, one row per repository with its state, live agent log, diff viewer, approve/follow-up/discard, PR link |
| **Settings**                 | API key, model, GitHub token or `gh` status, concurrency, language                                                                 |

All text goes through Paraglide (`messages/en.json` and `es.json`). Components come from
shadcn-svelte.

## 8. Milestones

- [x] **M0: Foundation.** SvelteKit + Tailwind + shadcn-svelte + Paraglide, with Vitest and
      Playwright tests. Capacitor (Android/iOS), Electron (Forge) and Docker (nginx) targets.
      Dashboard shell with the left sidebar and placeholder pages.
- [x] **M1: Repositories on desktop.**
  - The engine contract, generic transport and typed client (see section 2).
  - `engine/repositories/`, `engine/git/git.ts` and `engine/core/store.ts`.
  - Electron main and preload scripts in TypeScript.
  - Repositories page: a path field plus the native folder picker. It validates the folder
    (exists, inside a git repository, has a remote, not already added) and lists each repository
    with its provider, slug, branches and uncommitted changes. Re-check and remove (with a
    confirmation) are included, and the dashboard counter uses the real count.
  - Tests: engine tests against temporary git repositories, client and state unit tests, and an
    Electron end-to-end test that adds, re-checks and removes a real repository.
- [x] **M2: Run a change on desktop.**
  - The engine pieces listed in section 2 (runs, worktrees, agent, policy, logs, events,
    secrets), the live event channel, and the Electron keychain secrets.
  - Pages:
    - New change: pick one or more repositories, instruction, optional branch name.
    - Runs list and run detail: live activity log, diff viewer, summary, cost and turns.
    - Cancel and discard.
    - Settings: model, time limit, API key.
  - The dashboard shows the active-run count.
  - Several repositories per run already work, with 2 tasks at a time.
  - Packaging: the agent SDK, `zod` and the native binary are included, with the binary unpacked
    from the archive. This adds about 320 MB to the desktop app.
  - Tests:
    - engine tests with fake agents (lifecycle, cancel, failure, validation, crash recovery,
      settings);
    - policy and state unit tests;
    - Electron end-to-end tests for the whole run flow, cancelling and settings, using a scripted
      agent selected with `PATCHWORK_TEST_AGENT`.
  - Verified with real runs in dev Electron and the packaged app.
- [x] **M3: Server mode.**
  - [`server/`](server/): one plain `node:http` server with:
    - static files with fallback to `index.html`;
    - the engine route and server-sent events;
    - an optional access token, a localhost-only rule when there's no token, and the JSON-only
      rule.
  - On the client: the HTTP transport, the reconnecting event stream with `resync`, an async
    `connectEngine`, `EngineGate`, and the token form.
  - Engine: `repositoryRoots` and `listRepositoryCandidates`, plus `FileSecretStore` for the
    server.
  - Docker:
    - one Node image (UI, server, git, the agent binary) running as UID 1000;
    - a `/data` volume and `REPOS_DIR` mounted at `/repos`;
    - published on `127.0.0.1` by default.
  - Tests:
    - server tests: static files, API, events, host, token and CORS rules;
    - browser end-to-end tests against the real server: the whole run flow, the folder rule,
      token login, and the static build without an engine.
  - Not covered by tests: the mobile app picking a server URL (see "Later").
- [x] **M4: Publish.**
  - Engine:
    - commit, push and open the GitHub PR (or reuse an existing one);
    - push only for other remotes;
    - retry after failures, and the diff kept after cleanup;
    - token-based HTTPS push.
  - UI:
    - the "Open pull request" dialog: title from the instruction, description from the
      summary, a draft option;
    - the PR link and publish errors on the task card;
    - the GitHub token in Settings;
    - the open-PR count on the dashboard.
  - A dummy remote and fake GitHub for testing: `npm run sandbox` and `npm run
electron:sandbox`.
  - Tests:
    - engine tests against a bare remote and the fake GitHub (PR, draft, missing token,
      push-only, failure and retry, existing PR, empty change);
    - Electron and browser end-to-end tests that publish.
  - Verified with a real agent run on the sandbox demo: the pushed branch's tests pass, and the
    PR was opened on the fake GitHub.
- [x] **M5: Many repositories.**
  - Repository search on New change, with "Select shown" and "Clear".
  - The concurrency setting.
  - Per-repository check commands, checks after the agent and on request, and the checks badge,
    tab and output on each task.
  - "Publish all ready", which preselects the tasks whose checks passed.
  - Tests:
    - engine tests: pass and fail, output, secrets not passed, cancel kills a long check,
      re-run, the concurrency limit and raising it while tasks wait;
    - an Electron end-to-end test: two repositories, one passing and one failing, then publish
      all ready, then fix the command and re-run;
    - a browser end-to-end test for search.
- [x] **M6: Polish.**
  - Follow-up instructions, including "Fix failing checks".
  - Run history: search (instruction, follow-ups, repository, branch) and status filters.
  - PR status sync, in the background and on demand, with Open, Merged and Closed badges.
  - Saved instruction templates: pick one or save the current instruction on New change, and
    manage them in Settings.
  - GitLab merge requests, behind a provider layer shared with GitHub. Settings has a reusable
    token section for both.
  - Dev tools:
    - a fake GitLab for tests;
    - the fake GitHub's PR pages gained Merge (a real merge into the dummy remote) and Close.
  - Tests:
    - engine: follow-up context, cumulative cost and diff, fixing checks, allowed states, PR
      sync on GitHub and GitLab, GitLab drafts, reuse and missing token, templates;
    - Electron: follow-ups and "Fix failing checks", the merged status after a refresh,
      templates from save to delete;
    - browser: run search and filters.
  - Electron tests now run with the window hidden and rendered offscreen
    (`PATCHWORK_HIDE_WINDOW=1`), so no windows appear on the desktop.
- [x] **Repositories by URL and GitHub sign-in** (after M6):
  - Clone by URL into the app's data folder (the "App copy" badge, deleted on remove), with
    authenticated clones and fetches for private repositories.
  - Local folders: on desktop by default; on a server only when mounted. Docker mounts nothing by
    default.
  - "Sign in with GitHub" through a GitHub App's device flow, and your GitHub repositories listed
    for one-click adding.
  - Tests: engine, browser and Electron, against the fake GitHub's device flow. A real clone of a
    public repository inside Docker was also checked.
- [x] **Web app local mode:**
  - `npm run server:local` runs the engine directly on your machine (`127.0.0.1`, home folder
    allowed, your Claude login).
  - A folder browser engine operation (`browseFolders`) powers Browse… in the web UI.
  - Root checks follow symlinks, so a link can't lead outside the allowed folders.
- [x] **Clone on demand:**
  - Repositories added by URL are cloned on first run or on request (`cloneRepository`).
  - Live clone status (`repository.updated` events) on the Repositories page.
  - GitHub repositories can be picked directly in New change.
  - Tests: engine (lazy add, clone on run, shared clone, failure and retry, unreachable URL),
    browser and Electron.
- [x] **Workflows: Review PR and Explore:**
  - Runs have a `kind`: `code`, `review` or `explore`. Read-only kinds get a detached worktree
    (no branch), read-only on disk and in the sandbox, the agent in read-only mode (file tools
    denied), and a JSON answer parsed onto
    the task (`review` or `exploration`). They finish as `completed`, and the copy is removed
    when they end.
  - Reviews fetch the PR head through `pull/N/head` (GitHub) or `merge-requests/N/head` (GitLab),
    which works for forks too, with the head branch as a fallback. They diff against the merge
    base.
  - New engine methods: `listPullRequests`, `startReview` (by link or by repository and number),
    `postReview` (a GitHub review comment or a GitLab note) and `startExplore`. Default
    attributes live in `settings.reviewAttributes`.
  - UI:
    - a "Workflows" sidebar group;
    - Review PR and Explore pages;
    - score and approach cards on the run page;
    - **Build this approach**, which starts a code run;
    - the attribute editor in Settings.
  - Tests:
    - engine: review end to end, link lookup, an unreadable answer, validation, explore and
      settings;
    - browser: review → post → explore → build, and the Settings editor.
- [x] **One Agent for every workflow:**
  - The Agent has an Auto / Change / Ask / Review / Explore switch. Ask (`startAsk`, run kind
    `ask`) is read-only like Explore: its answer is the task summary, and follow-ups get the
    earlier answer. Auto guesses the mode from the
    message with keyword rules (`detectAgentMode`): instant, free and testable. A wrong guess is
    one click to fix. Text besides the link and the request itself ("review this PR") becomes
    the review's focus (`reviewFocus`).
  - Its side panel adapts to the mode:
    - repositories, plus the branch name for one repository;
    - or the pull request picker and what to rate.
  - Reports render as cards in the conversation; their JSON is hidden.
  - Read-only follow-ups: a question on a finished review or exploration runs in a fresh detached
    copy, with the original task, the previous JSON and the earlier questions. A plain answer
    keeps the report. A changed review clears its posted link so it can be posted again.
  - From question to change: `switchToChange` turns a finished Ask or Explore run into a code run
    in place (`switchedFrom` records when). Each repository gets a branch and a worktree, and
    the agent's first prompt carries the question, the follow-ups and the latest answer (or the
    exploration). The reply box has Auto / Ask (or Explore) / Change; Auto switches only when
    the model says "change", never on the keyword rules, which would call most replies changes.
  - The sidebar shows only Agent under Workflows. `/changes/new`, `/review` and `/explore`
    redirect to `/agent?mode=…`.
- [ ] **Later:** the mobile app as a client for a hosted server. Most of it is built: the HTTP
      transport, token auth and CORS. What's left is a screen to enter the server URL and token,
      plus storing them on the device.

## 9. Open questions

- **Single user or a team?** If the Docker server is shared, it needs login and per-user tokens.
  The plan above assumes a single user.
- **Running the repository's tests automatically?** Answered in M5: an optional check command per
  repository. In M6, fixing failing checks is one click ("Fix failing checks"). Still open:
  should that happen automatically, once, when checks fail? It costs more, but it's often worth
  it.
- **Where does the agent run for mobile users?** Only on a server. The plan doesn't make phones
  edit code locally.
- **Monorepos:** one PR per repository is the default. Is a "sub-folder scope" for an instruction
  needed?
