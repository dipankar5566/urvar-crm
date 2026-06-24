# Urvar CRM

CRM for **Urvar Natural Pvt Ltd** — a B2B/B2C sales platform for organic
fertilizers, bio-fertilizers, soil conditioners, and micronutrients. Built
similar to Zoho Bigin but optimized for agricultural distribution (distributors,
dealers, retailers, FPOs, government tenders, and farmers).

## Tech Stack

- **Next.js 16** (App Router, TypeScript) — full-stack, Server Actions + Route Handlers
- **Prisma 7** ORM with the `@prisma/adapter-pg` driver adapter
- **PostgreSQL** (local, portable install — see below)
- **Better Auth** — email/password auth with role-based session
- **Tailwind CSS v4 + shadcn/ui** (Base UI under the hood)
- **next-themes** — dark mode

## Prerequisites

- Node.js 20+
- PostgreSQL 17 running on `localhost:5432`

### Portable PostgreSQL (this machine)

Postgres is installed as a **portable, no-admin instance** at
`D:\PostgresPortable` (binaries + data live outside the repo). It is **not** a
Windows service, so it must be started after a reboot:

```powershell
npm run pg:start    # start the database
npm run pg:stop     # stop the database
```

Connection: `postgresql://postgres:postgres@localhost:5432/urvar_crm`

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
  schema.prisma          # full normalized schema (19 models)
  seed.ts                # demo data (users, products, leads, customers, quotations…)
prisma.config.ts         # Prisma 7 config (datasource url lives here, not in schema)
src/
  app/
    (auth)/login/        # login page + form
    (dashboard)/         # authenticated app shell (sidebar + topbar)
      dashboard/         # KPI dashboard (role-scoped metrics)
      leads/ pipeline/ calls/ follow-ups/ tasks/
      customers/ products/ quotations/ reports/
      users/ audit-logs/ # Super Admin only
    api/auth/[...all]/   # Better Auth handler
  components/
    ui/                  # shadcn/ui components
    layout/              # sidebar, topbar
  lib/
    auth.ts              # Better Auth server config
    auth-client.ts       # Better Auth React client
    session.ts           # getCurrentUser / requireUser / requireRole
    prisma.ts            # Prisma client singleton (pg adapter)
    permissions.ts       # RBAC matrix + can() + scopeWhere()
    constants/           # territories, enum labels, nav config
  middleware.ts          # coarse auth gating
scripts/
  pg-start.ps1 / pg-stop.ps1
```

## RBAC

Two enforcement layers:
1. **`middleware.ts`** — coarse: unauthenticated → `/login`.
2. **Server-side** — `requireRole()` in role-gated pages + `can(role, module, action)`
   checks in Server Actions, with `scopeWhere()` building the Prisma `where`
   clause per scope (`all` / `territory` / `own` / `none`). Matrix in
   `src/lib/permissions.ts`.

## Build Roadmap

- **Sprint 0 (done)** — scaffolding, auth, DB, schema, RBAC, dashboard shell, seed.
- **Sprint 1 (done)** — Leads (CRUD, filters, activity timeline) + Pipeline Kanban (`@dnd-kit`), stage↔status sync, lead-to-customer conversion.
- **Sprint 2 (done)** — Calls (quick-log + history), Follow-ups (overdue/today/upcoming views, complete/reschedule/cancel), Tasks (assignment, status, due-date views), in-app Notification bell on lead/task assignment.
- **Sprint 3** — Customers / Distributors / Dealers.
- **Sprint 4** — Products + Quotations + PDF.
- **Sprint 5** — Dashboard charts + Reports (CSV/Excel).
- **Sprint 6** — Audit logs + RBAC hardening + polish.

Phase 2 (deferred): WhatsApp/Email integration, AI lead scoring/forecasting,
mobile field app with GPS, Docker/AWS deployment.
