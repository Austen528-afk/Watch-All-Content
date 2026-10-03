-- StreamX: reset a video's view count from the authenticated Admin panel.
-- Normal view counting and its existing cooldown remain in place.
-- This setup creates the reset action; it does not reset any video data.

create or replace function public.reset_streamx_video_views(p_video_id bigint)
returns table (video_id bigint, removed_views bigint, views bigint)
language plpgsql
security invoker
set search_path = ''
as $function$
declare
    previous_views bigint;
begin
    if auth.uid() is null
       or public.is_streamx_admin() is distinct from true then
        raise exception 'Only StreamX admins can reset video views.'
            using errcode = '42501';
    end if;

    if p_video_id is null or p_video_id <= 0 then
        raise exception 'A valid video ID is required.'
            using errcode = '22023';
    end if;

    select coalesce(v.views, 0)::bigint
    into previous_views
    from public.videos as v
    where v.id = p_video_id
    for update;

    if not found then
        raise exception 'Video not found.'
            using errcode = 'P0002';
    end if;

    update public.videos as v
    set views = 0
    where v.id = p_video_id;

    return query select p_video_id, previous_views, 0::bigint;
end;
$function$;

revoke all on function public.reset_streamx_video_views(bigint) from public, anon;
grant execute on function public.reset_streamx_video_views(bigint) to authenticated;
