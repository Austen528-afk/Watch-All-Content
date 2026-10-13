begin;

alter table public.videos
  add column if not exists gif_preview_url text,
  add column if not exists gif_original_duration_seconds numeric(12,3),
  add column if not exists gif_duration_seconds numeric(12,3),
  add column if not exists gif_size_bytes bigint,
  add column if not exists gif_verified_at timestamptz;

-- PR #5 already treats uploaded GIF thumbnails as full-length animations.
-- Preserve those URLs and expose them through the dedicated GIF field.
update public.videos
set gif_preview_url = thumbnail_url
where gif_preview_url is null
  and thumbnail_url ~* '\.gif([?#]|$)';

create table if not exists public.video_gif_processing_jobs (
  id uuid primary key default gen_random_uuid(),
  video_id bigint not null references public.videos(id) on delete cascade,
  source_video_url text not null,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'completed', 'failed')),
  force_regenerate boolean not null default false,
  batch_id uuid,
  requested_by uuid references auth.users(id) on delete set null,
  progress_percent integer not null default 0
    check (progress_percent between 0 and 100),
  stage text not null default 'queued',
  attempts integer not null default 0
    check (attempts >= 0),
  original_duration_seconds numeric(12,3),
  gif_duration_seconds numeric(12,3),
  gif_size_bytes bigint,
  processing_seconds numeric(12,2),
  output_url text,
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  updated_at timestamptz not null default now(),
  next_attempt_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists video_gif_processing_jobs_status_created_idx
  on public.video_gif_processing_jobs(status, created_at);

create index if not exists video_gif_processing_jobs_video_created_idx
  on public.video_gif_processing_jobs(video_id, created_at desc);

create unique index if not exists video_gif_processing_jobs_one_active_per_video_idx
  on public.video_gif_processing_jobs(video_id)
  where status in ('queued', 'processing');

alter table public.video_gif_processing_jobs enable row level security;

revoke all on public.video_gif_processing_jobs from anon, authenticated;
grant select on public.video_gif_processing_jobs to authenticated;
grant all on public.video_gif_processing_jobs to service_role;

drop policy if exists streamx_admin_read_gif_jobs
  on public.video_gif_processing_jobs;

create policy streamx_admin_read_gif_jobs
  on public.video_gif_processing_jobs
  for select
  to authenticated
  using (public.is_streamx_admin());

comment on column public.videos.gif_preview_url is
  'Verified, full-duration animated GIF preview in Cloudflare R2; separate from playable video and HLS URLs.';

comment on table public.video_gif_processing_jobs is
  'Resumable, serialized full-duration GIF processing jobs for StreamX videos.';

commit;
