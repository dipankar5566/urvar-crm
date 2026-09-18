# Urvar CRM

CRM for **Urvar Natural Pvt Ltd** — a B2B/B2C sales platform for organic
fertilizers, bio-fertilizers, soil conditioners, and micronutrients. Built
similar to Zoho Bigin but optimized for agricultural distribution (distributors,
dealers, retailers, FPOs, government tenders, and farmers).

## Tech Stack

- **Next.js 16** (App Router, TypeScript) — full-stack, Server Actions + Route Handlers
- **Prisma 7** ORM with the `@prisma/adapter-pg` driver adapter
- **PostgreSQL** (standard Windows service on this machine — see below)
- **Better Auth** — email/password auth with role-based session
- **Tailwind CSS v4 + shadcn/ui** (Base UI under the hood)
- **next-themes** — dark mode

## Prerequisites

- Node.js 20+
- PostgreSQL 17 running on `localhost:5432`

### PostgreSQL (this machine)

Postgres runs as the standard `postgresql-x64-18` Windows service
(Automatic startup — no manual start/stop needed after a reboot). This same
database instance serves both local dev and production (`urvar_crm` on
`localhost:5432`), shared with the PM2-hosted deployment — see `CLAUDE.md`.

## Setup

```bash
npm install
npm run db:generate     # generate the Prisma client
npm run db:migrate      # apply migrations
npm run db:seed         # load demo data
npm run dev             # http://localhost:3000
```

## Demo accounts

All accounts use password **`Urvar@123`**:

| Role | Email |
| --- | --- |
| Super Admin | admin@urvar.in |
| Sales Manager | rajesh.manager@urvar.in |
| Sales Executive | priya.sales@urvar.in |
| Distributor Manager | amit.distributor@urvar.in |
| Accounts Team | sunita.accounts@urvar.in |

## Project Structure

```
prisma/
  schema.prisma          # full normalized schema (24 models)
  seed.ts                # demo data (users, products, leads, customers, quotations…)
prisma.config.ts         # Prisma 7 config (datasource url lives here, not in schema)
instrumentation.ts       # starts the due-reminder + AI backlog crons on server boot
scripts/                 # backup-db.ps1 / restore-db.ps1 / register-backup-task.ps1
voice-agent/             # standalone AI voice agent process (own PM2 app)
  server.ts              # Plivo <Stream> + live-assist WebSocket host
  pipeline/              # STT, TTS, LLM provider, prompt building
  lib/                   # Neo4j knowledge-graph client + fact resolution
  tools/                 # CRM tools exposed to the model
src/
  app/
    (auth)/login/        # login page + form
    (dashboard)/         # authenticated app shell (sidebar + topbar)
      dashboard/         # KPI dashboard (role-scoped metrics)
      leads/ pipeline/ calls/ follow-ups/ tasks/ field-visits/
      customers/ products/ quotations/ purchases/ reports/
      users/ audit-logs/ # Super Admin only
    api/auth/[...all]/   # Better Auth handler
    api/quotations/accept/[token]/  # public customer accept-link (no session)
  components/
    ui/                  # shadcn/ui components
    layout/              # sidebar, topbar
  lib/
    auth.ts              # Better Auth server config
    auth-client.ts       # Better Auth React client
    session.ts           # getCurrentUser / requireUser / requireRole
    prisma.ts            # Prisma client singleton (pg adapter)
    permissions.ts       # RBAC matrix + can() + scopeWhere()
    safe-zone.ts         # "safe zone" deal classifier (standard price, known customer)
    ai-call-dialer.ts    # shared AI outbound dialer (dashboard action + cron)
    ai-backlog-cron.ts   # outbound sweep over never-contacted leads (off by default)
    reminder-cron.ts     # due reminders, quotation chases, stale-lead escalation
    constants/           # territories, enum labels, nav config
  middleware.ts          # coarse auth gating (everything except /api/**)
```

## RBAC

Two enforcement layers:
1. **`middleware.ts`** — coarse: unauthenticated → `/login`.
2. **Server-side** — `requireRole()` in role-gated pages + `can(role, module, action)`
   checks in Server Actions, with `scopeWhere()` building the Prisma `where`
   clause per scope (`all` / `territory` / `own` / `none`). Matrix in
   `src/lib/permissions.ts`.

## Status

All core modules are implemented: Leads, Pipeline, Calls, Follow-ups, Tasks,
Field Visits, Customers/Distributors/Dealers, Products, Quotations, Reports,
Audit logs, and Procurement (Purchases). See `CLAUDE.md` for module-by-module
detail, RBAC specifics, and recent fixes.

Beyond the original scope, the app also has a Plivo-based AI voice calling
agent (bilingual English/Hindi/Bengali) that can autonomously handle
outbound sales calls, Sarvam-powered document intelligence for extracting
data from uploaded invoices/lead documents, Leaflet/OpenStreetMap-based
customer geolocation, and a GPS-stamped field check-in/check-out log for
reps visiting a lead or customer in person.

A quotation marked Sent emails the customer a PDF copy (SMTP via Zoho Mail)
and is logged either way in `MessageLog`; WhatsApp delivery for the same
event is implemented but ships switched off pending a Meta-approved
template. Follow-ups and tasks that pass their due date get an in-app +
email reminder from an in-process cron, which also chases quotations that
were sent but never answered and escalates leads nobody has called.

Deployed to production at `crm.urvarindia.com` via PM2 + Cloudflare Tunnel
on the same Windows box used for local dev — not the Docker/AWS path
originally planned. The `urvar_crm` database is backed up nightly at 02:00
by a Windows Scheduled Task (`scripts/backup-db.ps1`, 14-day retention);
`scripts/restore-db.ps1` restores into a disposable database by default so
a mistyped run cannot overwrite production.

### Sales-funnel automation

A phased effort to stop the funnel depending on a rep remembering to act.
Shipped so far: the reminder/escalation sweeps above; automatic pipeline
stage sync when a quotation is sent; a read-only "safe zone" classifier
(`src/lib/safe-zone.ts`) that flags deals which are standard-priced to a
known customer in good standing; and a Neo4j knowledge graph (separate
`urvar-knowledge-graph` repo) that resolves a lead's district and crops
into agronomy facts injected into the voice agent's prompt at call setup.

Three further capabilities are **built and deployed but switched off**,
each behind its own env flag — flipping one is a `.env` edit plus a
`pm2 restart`, no rebuild:

| Flag | What it enables |
| --- | --- |
| `AI_AUTO_QUOTE_ENABLED` | Voice agent can create and send a quotation itself, but only for a safe-zone deal |
| `QUOTATION_ACCEPT_LINK_ENABLED` | Emailed quotations carry a link letting the customer accept, creating the Order with no rep |
| `AI_OUTBOUND_BACKLOG_ENABLED` | Scheduled AI calls into the backlog of leads nobody has contacted |

`AI_OUTBOUND_BACKLOG_ENABLED` additionally needs legal sign-off on TRAI DND
exposure before it is turned on — see the warning in `ai-backlog-cron.ts`.

Remaining from the original Phase 2 scope: activating the WhatsApp template
(pending Meta approval) and a dedicated mobile field app — field visits
today are a web-based check-in/check-out, not a native app.
