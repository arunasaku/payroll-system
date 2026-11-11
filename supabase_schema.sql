-- ==============================================================================
-- Supabase Schema for HR & Payroll Management System
-- Run this script in the Supabase Dashboard -> SQL Editor -> New query
-- ==============================================================================

-- 1. Master Payroll Data (Settings, Departments, Employees, Attendance, Leaves, Adjustments)
create table if not exists public.payroll_master_data (
    id text primary key,
    data jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now()
);

comment on table public.payroll_master_data is 'Stores company configurations, master employee registry, daily attendance, and adjustments in JSONB format.';

-- 2. Monthly Processed Payroll Runs
create table if not exists public.payroll_runs (
    month text primary key, -- e.g. '2026-10'
    runs jsonb not null default '[]'::jsonb,
    updated_at timestamptz not null default now()
);

comment on table public.payroll_runs is 'Stores processed paysheet and calculated payroll runs for each pay cycle.';

-- 3. System Users & RBAC
create table if not exists public.payflow_users (
    username text primary key,
    password text not null,
    role text not null default 'employee',
    department text default 'General',
    active boolean not null default true,
    permissions jsonb not null default '[]'::jsonb,
    updated_at timestamptz not null default now()
);

comment on table public.payflow_users is 'User accounts and portal module access permissions.';

-- 4. Cross-site internal coordination communication (SVS Module)
create table if not exists public.cross_site_chat (
    id text primary key,
    sender_site text not null default 'payroll',
    sender_admin text,
    channel text default 'cross',
    recipient text,
    reply_to_id text,
    reply_to_sender text,
    reply_to_text text,
    content text,
    file_name text,
    file_data text,
    timer_sec integer default 60,
    read_at text,
    created_at timestamptz not null default now()
);

-- 5. Cross-site Heartbeat / Status
create table if not exists public.cross_site_status (
    site text primary key, -- e.g. 'payroll', 'unicat'
    last_seen bigint default 0,
    active_admin text,
    peer_id text,
    updated_at timestamptz not null default now()
);

-- ==============================================================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- Enable RLS and grant full client-side access with the public anon key
-- ==============================================================================

alter table public.payroll_master_data enable row level security;
alter table public.payroll_runs enable row level security;
alter table public.payflow_users enable row level security;
alter table public.cross_site_chat enable row level security;
alter table public.cross_site_status enable row level security;

-- Drop existing policies if re-running
drop policy if exists "Anon full access on payroll_master_data" on public.payroll_master_data;
drop policy if exists "Anon full access on payroll_runs" on public.payroll_runs;
drop policy if exists "Anon full access on payflow_users" on public.payflow_users;
drop policy if exists "Anon full access on cross_site_chat" on public.cross_site_chat;
drop policy if exists "Anon full access on cross_site_status" on public.cross_site_status;

-- Create policies allowing select, insert, update, delete for public/anon
create policy "Anon full access on payroll_master_data" on public.payroll_master_data for all using (true) with check (true);
create policy "Anon full access on payroll_runs" on public.payroll_runs for all using (true) with check (true);
create policy "Anon full access on payflow_users" on public.payflow_users for all using (true) with check (true);
create policy "Anon full access on cross_site_chat" on public.cross_site_chat for all using (true) with check (true);
create policy "Anon full access on cross_site_status" on public.cross_site_status for all using (true) with check (true);

-- Enable Realtime (safe idempotent block so re-running never fails)
do $$
begin
    begin alter publication supabase_realtime add table public.payflow_users; exception when others then null; end;
    begin alter publication supabase_realtime add table public.payroll_master_data; exception when others then null; end;
    begin alter publication supabase_realtime add table public.payroll_runs; exception when others then null; end;
    begin alter publication supabase_realtime add table public.cross_site_chat; exception when others then null; end;
    begin alter publication supabase_realtime add table public.cross_site_status; exception when others then null; end;
end $$;
