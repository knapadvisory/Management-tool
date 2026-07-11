# TeamHub — Internal Team Tool

A self-hosted internal collaboration tool inspired by **Slack** (messaging, calls) and **Bitrix24** (tasks, workflows).

## Features

**💬 Messaging (Slack-style)**
- A **Messenger** view (Bitrix-style) — a single screen listing every conversation (channels + direct messages) with last-message previews and timestamps on the left, and the open chat on the right; start a new chat with any teammate from the same list
- **Collabs** — private group spaces for a focused engagement, each with an **owner and moderators** and configurable **access permissions**: who can invite members, who can post messages, and whether new members can see earlier history. Create one from the Collabs tab, manage it from the Access-permissions panel
- Public channels (everyone starts in `#general`) — create and join channels from the sidebar
- 1:1 direct messages with any teammate
- Real-time delivery, typing indicators, and online/offline presence dots
- **File & image sharing** — attach files to any message; images preview inline
- **Emoji reactions** on any message
- **Threads** — reply in a side panel to keep channels tidy
- **Message actions** — a per-message ⋯ menu: Reply (thread), Copy, Edit, **Forward** to another conversation, **Create task** from the message, and Delete
- **Edit & delete** your own messages
- **@mentions** with autocomplete; mentioned teammates get a notification
- **Message search** across every channel you're in
- **Markdown formatting** — bold, italics, lists, links, and code blocks

**📞 Calls**
- 1:1 audio and video calls from any DM, powered by WebRTC (peer-to-peer media, server only relays signaling)
- Incoming-call screen with accept/decline

**☑ Tasks (Bitrix-style)**
- Create tasks with description, priority (low → urgent), due date
- **Status lifecycle** — every task is In Progress / Completed / On Hold / Cancelled; putting one on hold or cancelling it requires a reason (recorded in the activity log). Anyone involved can change status; **only an admin can delete a task**
- Assign tasks to any team member — assignees get a real-time notification
- **Templates** — prepare a repeatable process once (e.g. Company Registration) with its standard steps, default priority, tags and board; start a new task from it and tweak per client
- **Projects** — group tasks under a client or initiative, each with its own color
- **Checklists / subtasks** with a live progress bar
- **Tags** for cross-cutting labels, with a tag filter
- **Watchers** — follow any task and get notified on chat, notes and stage moves
- **File attachments** on tasks
- **Per-task chat** for real-time back-and-forth, plus lasting **Notes** and an automatic activity log
- **Recurring tasks** — set a task to repeat daily / weekly / monthly / yearly; completing it auto-creates the next occurrence (tags, checklist and reminders carried over) — ideal for monthly filings and periodic reviews
- **Reminders** — one or more time-based reminders per task, delivered to the assignee and watchers through the notification bell (with a pop-up); handy presets relative to the due date
- **Quick add (natural language)** — type `File GST return tomorrow !high #compliance` and the due date, priority and tags are parsed out for you
- **Three views**: Kanban board (drag & drop), sortable List, and Calendar
- **Smart date views**: filter to Today, Next 7 days, Upcoming, Overdue, or No due date
- Filters: project, tag, assigned-to-me, and watching
- Due-date awareness: overdue and due-soon tasks are visually flagged
- Watchers are notified on every meaningful change — assignment, stage moves, edits (title/priority/due date), notes, chat, and deletion

**👑 Organisation & roles**
- **Your profile** — click your name in the sidebar to edit your own display name, title and avatar colour, and to change your own password (verifying the current one) — no admin needed
- The **first person to register** the workspace becomes the **super admin**
- An **Admin** panel (super-admin only) to run the team: create teammates directly, promote/demote between Admin and Member, reset passwords, and **deactivate** (revoke access — reversible, keeps all their data) or reactivate accounts
- **Task privacy** — regular members see only the tasks they created, are assigned, or watch; **super admins see every task** for supervision
- Admins have **full oversight** — every task and profile is visible to them for supervision
- Share the **invite link** (plus the sign-up access code, if set) so teammates create their own login; deactivated users are logged out immediately and can't sign back in

**🔔 Activity & Files**
- An **Activity** tab (with an unread badge) collecting every notification — @mentions, task assignments, task chat, reminders, status changes and activity on tasks you watch — with All / Unread / Mentions / Tasks filters and mark-all-read; click one to jump straight to the channel or task
- A **Files** manager listing every file shared across your conversations and tasks — sortable **Name / Owner / Shared-on / Size** columns, **Details** and **Icons** views, search, multi-select with an action bar (Open, Details, Download, Delete), and **in-app preview** for images, PDFs, Excel (`.xlsx`, with sheet tabs), Word (`.docx`), CSV and text. You can only delete files **you** shared (WhatsApp-style); a deleted file disappears for everyone but is kept in the **admin Archive**, where a super admin can restore it or delete it permanently
- A shared team **Drive** — a common file library everyone can see, organised into **folders and subfolders**. Create folders, navigate with breadcrumbs, upload files into the current folder (button or drag-and-drop) and move files between folders; any teammate can open, preview or download them. It uses the same file-manager interface as Files (columns, sort, views, search, selection). You can only delete files **you** uploaded (deletions land in the admin Archive just like Files), and only a folder's creator or an admin can rename or delete it — and only when it's empty
- **Tag people on a Drive file** — when you upload (or later, via the selection bar), tag the teammates a file is *for*. Their avatars show in a **Shared with** column and each tagged person gets a notification in their Activity feed. It's a label, not a lock — the Drive stays team-wide
- **Google-Drive-style file management** — right-click any file or folder (or the empty background) for a context menu; **cut/copy/paste** with `Ctrl/⌘ X/C/V` to move or duplicate files between folders; drag a **whole folder** onto the Drive to upload it with its subfolders intact (or use the 📂 Folder button); rename files; and upload any file type (up to 100 MB each)
- Assign a task to a teammate straight from the **Team** directory via a quick popup
- **Desktop notifications** — opt in from the sidebar (🖥️) to get native browser/desktop alerts when the tab is in the background (mentions, assignments, task activity, reminders) and for incoming calls; clicking an alert focuses TeamHub and opens the relevant item

**⚙ Workflows**
- Define custom workflows (e.g. *Client Onboarding: Intake → KYC → Proposal → Signed*)
- Each workflow has ordered stages and its own task board
- Add/remove stages at any time; a sensible Default workflow is seeded on first run

## Tech stack

| Layer | Choice |
|---|---|
| Server | Node.js, Express, Socket.IO |
| Database | SQLite (`better-sqlite3`) — zero-setup, file-based |
| Auth | JWT + bcrypt |
| Client | React 18 + Vite |
| Calls | WebRTC with Socket.IO signaling |
| Uploads | Multer (files stored under `DATA_DIR/uploads`) |
| Formatting | Markdown via `marked`, sanitized with `DOMPurify` |

## Getting started

```bash
# 1. Install dependencies
npm install            # root (dev tooling)
npm run install:all    # server + client

# 2. Run in development (server on :3001, client on :5173)
npm run dev
```

Open http://localhost:5173, create an account, and you're in. Teammates register themselves from the same screen.

### Tests

```bash
npm test --prefix server
```

Boots the real server against a throwaway database and smoke-tests the REST API (auth, channels, DMs, tasks, workflows) and the socket layer (messaging, presence, call signaling). The same suite runs in CI on every pull request.

### Production

```bash
npm run build          # builds the client into client/dist
JWT_SECRET=some-long-random-string npm start
```

The server serves the built client at http://localhost:3001 (single process, single port).

**Deploy to a custom domain:** see [DEPLOY.md](DEPLOY.md) — the repo ships a `Dockerfile` for one-click deploys on Railway (or any Docker host), with your own domain and automatic HTTPS.

**Environment variables**

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | HTTP + WebSocket port |
| `JWT_SECRET` | dev value | Set to a long random string in production |
| `DATA_DIR` | `server/data` | Where the SQLite database + uploads live (mount a persistent disk in production) |
| `SIGNUP_CODE` | _(unset)_ | If set, registration requires this shared access code — so a public link can be shared only with the people you give it to. Leave unset for open registration. |

> Note: browsers require HTTPS (or localhost) for microphone/camera access, so put the app behind TLS (e.g. a reverse proxy) before using calls in production. For teams on restrictive networks you may also need a TURN server in `client/src/components/CallManager.jsx`.

## Project layout

```
server/
  src/index.js        Express app, REST API mounting, static client serving
  src/db.js           SQLite schema + seed data
  src/auth.js         Register/login, JWT helpers, auth middleware
  src/socket.js       Real-time chat, presence, call signaling
  src/routes/         channels, tasks, workflows
client/
  src/App.jsx         Session, socket lifecycle, view switching
  src/components/     Sidebar, ChatView, CallManager, TasksBoard, TaskModal, WorkflowsView
```
