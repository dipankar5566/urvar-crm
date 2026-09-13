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
instrumentation.ts       # starts the due-reminder cron on server boot
src/
  app/
    (auth)/login/        # login page + form
    (dashboard)/         # authenticated app shell (sidebar + topbar)
      dashboard/         # KPI dashboard (role-scoped metrics)
      leads/ pipeline/ calls/ follow-ups/ tasks/ field-visits/
      customers/ products/ quotations/ purchases/ reports/
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
email reminder from an in-process cron.

Deployed to production at `crm.urvarindia.com` via PM2 + Cloudflare Tunnel
on the same Windows box used for local dev — not the Docker/AWS path
originally planned.

Remaining from the original Phase 2 scope: activating the WhatsApp template
(pending Meta approval) and a dedicated mobile field app — field visits
today are a web-based check-in/check-out, not a native app.
