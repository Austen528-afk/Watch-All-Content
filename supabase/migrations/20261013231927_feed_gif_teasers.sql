-- Keep compact feed animation metadata separate from full-duration GIF media.
alter table public.videos
  add column if not exists gif_teaser_url text,
  add column if not exists gif_teaser_duration_seconds numeric(12,3),
  add column if not exists gif_teaser_size_bytes bigint;

comment on column public.videos.gif_teaser_url is
  'Public URL for the compact animated feed teaser; gif_preview_url remains the full-duration GIF.';
comment on column public.videos.gif_teaser_duration_seconds is
  'Duration in seconds for the compact feed GIF teaser.';
comment on column public.videos.gif_teaser_size_bytes is
  'Byte size for the compact feed GIF teaser.';
