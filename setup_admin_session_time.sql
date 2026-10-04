-- StreamX individual session averages. Run after setup_admin_users_reset.sql.
-- Additive: preserves all activity, accounts, engagement and the legacy writer.

alter table public.viewer_time_sessions add column if not exists visit_id uuid;
create index if not exists viewer_time_sessions_viewer_started_idx
    on public.viewer_time_sessions (viewer_id, platform, started_at);

-- Context segments keep their own IDs for the existing Library graphs. A visit
-- ID groups those segments into one session without changing their durations.
create or replace function streamx_private.record_viewer_visit_time(
    p_session_id uuid,
    p_visit_id uuid,
    p_viewer_id text,
    p_platform text,
    p_context text,
    p_duration_seconds bigint,
    p_ended boolean default false
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare
    saved_seconds bigint;
begin
    if p_visit_id is null then
        raise exception 'A visit ID is required.' using errcode = '22023';
    end if;

    -- The existing writer verifies the live Auth account, binds viewer_id to
    -- auth.uid(), checks segment ownership/platform/context and caps duration.
    saved_seconds := public.record_viewer_time(
        p_session_id, p_viewer_id, p_platform, p_context, p_duration_seconds, p_ended
    );

    update public.viewer_time_sessions as s
    set visit_id = p_visit_id
    where s.session_id = p_session_id and s.viewer_id = auth.uid()::text
      and (s.visit_id is null or s.visit_id = p_visit_id);

    if not found then
        raise exception 'The segment belongs to another visit.' using errcode = '42501';
    end if;
    return saved_seconds;
end;
$function$;

revoke all on function streamx_private.record_viewer_visit_time(uuid,uuid,text,text,text,bigint,boolean)
    from public, anon;
grant execute on function streamx_private.record_viewer_visit_time(uuid,uuid,text,text,text,bigint,boolean)
    to authenticated, service_role;

-- Keep the privileged implementation outside the exposed API schema.
create or replace function public.record_viewer_visit_time(
    p_session_id uuid,
    p_visit_id uuid,
    p_viewer_id text,
    p_platform text,
    p_context text,
    p_duration_seconds bigint,
    p_ended boolean default false
)
returns bigint
language sql
security invoker
set search_path = ''
as $function$
    select streamx_private.record_viewer_visit_time(
        p_session_id,p_visit_id,p_viewer_id,p_platform,p_context,p_duration_seconds,p_ended
    );
$function$;
revoke all on function public.record_viewer_visit_time(uuid,uuid,text,text,text,bigint,boolean)
    from public, anon;
grant execute on function public.record_viewer_visit_time(uuid,uuid,text,text,text,bigint,boolean)
    to authenticated, service_role;

create or replace function streamx_private.get_admin_viewers(p_offset integer, p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
    result jsonb;
begin
    if auth.uid() is null or public.is_streamx_admin() is distinct from true then
        raise exception 'Only StreamX admins can manage viewers.' using errcode = '42501';
    end if;
    if p_offset is null or p_offset < 0 or p_limit is null or p_limit < 1 or p_limit > 50 then
        raise exception 'Invalid viewer page.' using errcode = '22023';
    end if;

    with viewer_rows as (
        select ids.viewer_id,
            (select u.created_at from auth.users u where u.id::text = ids.viewer_id) as joined_at,
            (select max(a.last_seen) from public.active_users a where a.user_id = ids.viewer_id) as last_seen,
            coalesce((select jsonb_agg(distinct case when a.platform = 'miniapp' then 'mini_app' else a.platform end)
                from public.active_users a where a.user_id = ids.viewer_id
                and a.platform in ('website','mini_app','miniapp')), '[]'::jsonb) as platforms,
            (select count(*) from public.video_likes l where l.user_id = ids.viewer_id) as likes_count,
            (select count(*) from public.video_library l where l.viewer_id = ids.viewer_id) as saves_count
        from streamx_private.viewer_ids ids
    ), page as (
        select * from viewer_rows
        order by last_seen desc nulls last, joined_at desc nulls last, viewer_id
        offset p_offset limit p_limit
    ), segments as (
        select s.* from public.viewer_time_sessions s
        join page p on p.viewer_id = s.viewer_id
    ), legacy_ordered as (
        select s.*,
            lag(s.context) over w as previous_context,
            lag(coalesce(s.ended_at, s.last_seen)) over w as previous_end
        from segments s where s.visit_id is null
        window w as (partition by s.viewer_id, s.platform order by s.started_at, s.session_id)
    ), legacy_numbered as (
        -- Earlier clients split a visit when Library opens/closes. Join only
        -- adjacent context changes within one heartbeat plus request allowance.
        -- Keep these estimates labelled; no historical rows are rewritten.
        select s.*,
            sum(case when s.previous_context is distinct from s.context
                and s.started_at between s.previous_end - interval '15 seconds'
                                     and s.previous_end + interval '15 seconds'
                then 0 else 1 end)
            over (partition by s.viewer_id, s.platform order by s.started_at, s.session_id) as visit_number
        from legacy_ordered s
    ), visits as (
        select s.viewer_id, s.platform, sum(s.duration_seconds) as duration_seconds, false as estimated
        from segments s where s.visit_id is not null
        group by s.viewer_id, s.platform, s.visit_id
        union all
        select s.viewer_id, s.platform, sum(s.duration_seconds), true
        from legacy_numbered s
        group by s.viewer_id, s.platform, s.visit_number
    ), metrics as (
        select v.viewer_id, count(*) as session_count,
            sum(v.duration_seconds) as total_session_seconds,
            avg(v.duration_seconds) as average_session_seconds,
            count(*) filter (where v.estimated) as estimated_session_count
        from visits v group by v.viewer_id
    ), enriched_page as (
        select p.*, coalesce(m.session_count,0) as session_count,
            coalesce(m.total_session_seconds,0) as total_session_seconds,
            m.average_session_seconds,
            coalesce(m.estimated_session_count,0) as estimated_session_count
        from page p left join metrics m on m.viewer_id = p.viewer_id
    )
    select jsonb_build_object(
        'total', (select count(*) from viewer_rows),
        'users', coalesce((select jsonb_agg(to_jsonb(p)
            order by p.last_seen desc nulls last, p.joined_at desc nulls last, p.viewer_id)
            from enriched_page p), '[]'::jsonb)
    ) into result;
    return result;
end;
$function$;

-- Preserve the existing admin authorization and authenticated wrapper grants.
revoke all on function streamx_private.get_admin_viewers(integer,integer) from public, anon;
grant execute on function streamx_private.get_admin_viewers(integer,integer) to authenticated;

notify pgrst, 'reload schema';
