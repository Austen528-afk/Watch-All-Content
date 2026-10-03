-- Allow dashboard/Data API GET reads while retaining account locks for writes.
-- No user records or counters are changed by this repair.
create or replace function streamx_private.current_user_exists()
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
    if auth.uid() is null then return false; end if;

    if current_setting('transaction_read_only') = 'on' then
        return exists (
            select 1 from auth.users as u
            where u.id = auth.uid() and u.deleted_at is null
        );
    end if;

    perform 1 from auth.users as u
    where u.id = auth.uid() and u.deleted_at is null
    for key share;
    return found;
end;
$function$;

-- StreamX: fetch current catalog counters for the authenticated Admin panel.
-- This reads counters; it does not rebuild the library or change media.
create or replace function public.get_streamx_admin_video_counts()
returns table (video_id bigint, views bigint, likes_count bigint)
language plpgsql
security invoker
set search_path = ''
as $function$
begin
    if auth.uid() is null or public.is_streamx_admin() is distinct from true then
        raise exception 'Only StreamX admins can read dashboard counters.'
            using errcode = '42501';
    end if;

    return query
    select v.id::bigint, coalesce(v.views,0)::bigint, count(l.id)::bigint
    from public.videos as v
    left join public.video_likes as l on l.video_id = v.id
    group by v.id, v.views
    order by v.id;
end;
$function$;

revoke all on function public.get_streamx_admin_video_counts() from public, anon;
grant execute on function public.get_streamx_admin_video_counts() to authenticated;
