begin;

alter table public.videos
  add column if not exists admin_gif_url text,
  add column if not exists admin_gif_size_bytes bigint;

-- Preserve GIFs that admins previously uploaded into the thumbnail field.
update public.videos
set admin_gif_url = thumbnail_url,
    admin_gif_size_bytes = coalesce(admin_gif_size_bytes, gif_size_bytes)
where admin_gif_url is null
  and thumbnail_url ~* '\.gif([?#]|$)';

comment on column public.videos.admin_gif_url is
  'Optional animated feed preview explicitly supplied by an administrator; empty means use the short video preview.';
comment on column public.videos.admin_gif_size_bytes is
  'Byte size of the optional administrator-supplied animated feed preview.';

commit;
