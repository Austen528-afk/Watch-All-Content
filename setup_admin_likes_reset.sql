-- Admin-only reset of all likes for one video.
-- Applied through Supabase migration admin_video_likes_reset.
-- SECURITY INVOKER keeps the existing RLS rules in force.

drop policy if exists "StreamX admin likes reset" on public.video_likes;
create policy "StreamX admin likes reset"
on public.video_likes
for delete
to authenticated
using (
    (select auth.uid()) is not null
    and (select public.is_streamx_admin())
);

create or replace function public.reset_streamx_video_likes(p_video_id bigint)
returns table(video_id bigint, removed_likes bigint, likes_count bigint)
language plpgsql
security invoker
set search_path = ''
as $function$
declare
    removed_count bigint;
    remaining_count bigint;
begin
    if auth.uid() is null or public.is_streamx_admin() is distinct from true then
        raise exception 'StreamX administrator access required'
            using errcode = '42501';
    end if;

    if p_video_id is null or p_video_id <= 0 then
        raise exception 'A valid video ID is required'
            using errcode = '22023';
    end if;

    -- Lock the parent video so newly inserted likes wait until this reset ends.
    perform 1 from public.videos v where v.id = p_video_id for update;
    if not found then
        raise exception 'Video not found' using errcode = 'P0002';
    end if;

    delete from public.video_likes l where l.video_id = p_video_id;
    get diagnostics removed_count = row_count;

    select count(*) into remaining_count
    from public.video_likes l where l.video_id = p_video_id;

    update public.videos v
    set likes_count = remaining_count::integer
    where v.id = p_video_id;

    return query select p_video_id, removed_count, remaining_count;
end;
$function$;

revoke all on function public.reset_streamx_video_likes(bigint) from public, anon;
grant execute on function public.reset_streamx_video_likes(bigint) to authenticated;
