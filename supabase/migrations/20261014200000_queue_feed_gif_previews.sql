-- Queue a short feed GIF preview from the original video even when the
-- existing thumbnail is already a static JPG poster.
create or replace function public.queue_streamx_feed_gif_processing(
    p_video_id bigint
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
    source_url text;
    active_job_id uuid;
    new_job_id uuid;
begin
    if auth.uid() is null
       or not public.is_streamx_admin() then
        raise exception 'StreamX admin authorization required';
    end if;

    if p_video_id is null then
        raise exception 'A video ID is required';
    end if;

    select coalesce(
        nullif(btrim(v.source_video_url), ''),
        case
            when v.video_url is not null
             and v.video_url not ilike '%.m3u8%'
            then v.video_url
            else null
        end
    )
    into source_url
    from public.videos v
    where v.id = p_video_id;

    if not found then
        raise exception 'Video not found';
    end if;

    if source_url is null or btrim(source_url) = '' then
        raise exception 'Video has no usable original source URL';
    end if;

    -- An active full, preview, or poster job also creates the five-second
    -- feed GIF in the deployed worker, so do not create duplicate work.
    select j.id
    into active_job_id
    from public.video_processing_jobs j
    where j.video_id = p_video_id
      and j.status in ('queued', 'processing')
    order by j.created_at desc
    limit 1;

    if active_job_id is not null then
        return active_job_id;
    end if;

    insert into public.video_processing_jobs (
        video_id,
        status,
        source_video_url,
        processing_type
    )
    values (
        p_video_id,
        'queued',
        source_url,
        'poster'
    )
    returning id into new_job_id;

    return new_job_id;
end;
$function$;

revoke all on function public.queue_streamx_feed_gif_processing(bigint)
    from public, anon;
grant execute on function public.queue_streamx_feed_gif_processing(bigint)
    to authenticated;
