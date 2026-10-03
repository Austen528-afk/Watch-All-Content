-- StreamX admin viewer reset. Creating these controls does not delete any users.
-- Viewer reset removes accounts and personal records, without banning visitors.
-- Admin/permanent accounts and video view totals are preserved.

create schema if not exists streamx_private;
revoke all on schema streamx_private from public, anon;
grant usage on schema streamx_private to authenticated;

-- Lock the live Auth row while a viewer request writes. Deletion waits for
-- in-flight writes; deleted access tokens cannot recreate the old records.
create or replace function streamx_private.current_user_exists()
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
    if auth.uid() is null then return false; end if;
    perform 1 from auth.users as u
    where u.id = auth.uid() and u.deleted_at is null
    for key share;
    return found;
end;
$function$;
revoke all on function streamx_private.current_user_exists() from public, anon;
grant execute on function streamx_private.current_user_exists() to authenticated;

create or replace function public.is_streamx_viewer_session_active()
returns boolean
language sql
security invoker
set search_path = ''
as $function$
    select streamx_private.current_user_exists();
$function$;
revoke all on function public.is_streamx_viewer_session_active() from public, anon;
grant execute on function public.is_streamx_viewer_session_active() to authenticated;

-- Internal inventory includes anonymous accounts and legacy viewer records.
-- It is never granted to frontend roles or exposed through the Data API.
create or replace view streamx_private.viewer_ids with (security_invoker = true) as
with candidates as (
    select u.id::text as viewer_id from auth.users u where u.is_anonymous
    union select a.user_id from public.active_users a where a.platform in ('website','mini_app','miniapp')
    union select l.user_id from public.video_likes l
    union select l.viewer_id from public.video_library l
    union select l.viewer_id from public.library_activity l
    union select l.viewer_id from public.library_save_events l
    union select s.viewer_id from public.video_watch_sessions s
    union select s.viewer_id from public.viewer_time_sessions s
    union select c.viewer_id::text from public.video_view_cooldowns c
    union select u.telegram_id from public.users u
)
select c.viewer_id
from candidates c
where nullif(btrim(c.viewer_id),'') is not null
and not exists (select 1 from public.streamx_admins a where a.user_id::text = c.viewer_id)
and not exists (select 1 from auth.users u where u.id::text = c.viewer_id and not u.is_anonymous)
and not exists (select 1 from public.active_users a where a.user_id = c.viewer_id and a.platform = 'admin');
revoke all on streamx_private.viewer_ids from public, anon, authenticated;

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
    )
    select jsonb_build_object(
        'total', (select count(*) from viewer_rows),
        'users', coalesce((select jsonb_agg(to_jsonb(page)) from page), '[]'::jsonb)
    ) into result;
    return result;
end;
$function$;
revoke all on function streamx_private.get_admin_viewers(integer,integer) from public, anon;
grant execute on function streamx_private.get_admin_viewers(integer,integer) to authenticated;

create or replace function public.get_streamx_admin_viewers(p_offset integer default 0, p_limit integer default 50)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
    select streamx_private.get_admin_viewers(p_offset, p_limit);
$function$;
revoke all on function public.get_streamx_admin_viewers(integer,integer) from public, anon;
grant execute on function public.get_streamx_admin_viewers(integer,integer) to authenticated;

create or replace function streamx_private.reset_viewers(p_viewer_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
    target_ids text[];
    affected_videos bigint[];
    deleted_auth_users bigint := 0;
    likes_updates jsonb;
begin
    if auth.uid() is null or public.is_streamx_admin() is distinct from true then
        raise exception 'Only StreamX admins can reset viewers.' using errcode = '42501';
    end if;
    if p_viewer_id is null or btrim(p_viewer_id) = '' or length(p_viewer_id) > 200 then
        raise exception 'A valid viewer ID is required.' using errcode = '22023';
    end if;
    select coalesce(array_agg(ids.viewer_id), array[]::text[]) into target_ids
    from streamx_private.viewer_ids ids
    where ids.viewer_id = p_viewer_id;
    if cardinality(target_ids) <> 1 then
        raise exception 'Viewer not found or this account is protected.' using errcode = 'P0002';
    end if;

    -- Acquire Auth locks before changing personal data. New visitors created
    -- after this reset remain new users. Exactly one viewer can be reset.
    perform 1 from auth.users u where u.id::text = any(target_ids)
    and u.is_anonymous order by u.id for update;
    select coalesce(array_agg(distinct l.video_id) filter (where l.video_id is not null), array[]::bigint[])
    into affected_videos from public.video_likes l where l.user_id = any(target_ids);

    -- Revoke refresh sessions before deleting their anonymous Auth accounts.
    delete from auth.sessions s where s.user_id::text = any(target_ids);
    delete from auth.users u where u.id::text = any(target_ids) and u.is_anonymous
    and not exists (select 1 from public.streamx_admins a where a.user_id = u.id);
    get diagnostics deleted_auth_users = row_count;

    delete from public.video_likes l where l.user_id = any(target_ids);
    delete from public.video_library l where l.viewer_id = any(target_ids);
    -- Library deletions create remove events; delete the history afterwards.
    delete from public.library_save_events l where l.viewer_id = any(target_ids);
    delete from public.library_activity l where l.viewer_id = any(target_ids);
    delete from public.video_watch_sessions s where s.viewer_id = any(target_ids);
    delete from public.viewer_time_sessions s where s.viewer_id = any(target_ids);
    delete from public.video_view_cooldowns c where c.viewer_id::text = any(target_ids);
    delete from public.users u where u.telegram_id = any(target_ids);
    delete from public.active_users a where a.user_id = any(target_ids) and a.platform <> 'admin';

    update public.videos v set likes_count = (
        select count(*)::integer from public.video_likes l where l.video_id = v.id
    ) where v.id = any(affected_videos);
    select coalesce(jsonb_agg(jsonb_build_object('video_id',v.id,'likes_count',v.likes_count)), '[]'::jsonb)
    into likes_updates from public.videos v where v.id = any(affected_videos);

    return jsonb_build_object(
        'deleted_users', cardinality(target_ids),
        'deleted_auth_users', deleted_auth_users,
        'likes_updates', likes_updates
    );
end;
$function$;
revoke all on function streamx_private.reset_viewers(text) from public, anon;
grant execute on function streamx_private.reset_viewers(text) to authenticated;

create or replace function public.reset_streamx_viewers(p_viewer_id text)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
    select streamx_private.reset_viewers(p_viewer_id);
$function$;
revoke all on function public.reset_streamx_viewers(text) from public, anon;
grant execute on function public.reset_streamx_viewers(text) to authenticated;

-- Existing ownership/admin policies still apply. This additional restriction
-- rejects writes from a deleted identity even while its old JWT is unexpired.
drop policy if exists "StreamX live viewer session" on public.active_users;
create policy "StreamX live viewer session" on public.active_users as restrictive
for all to authenticated using ((select streamx_private.current_user_exists()))
with check ((select streamx_private.current_user_exists()));
drop policy if exists "StreamX live viewer session" on public.video_likes;
create policy "StreamX live viewer session" on public.video_likes as restrictive
for all to authenticated using ((select streamx_private.current_user_exists()))
with check ((select streamx_private.current_user_exists()));
drop policy if exists "StreamX live viewer session" on public.video_library;
create policy "StreamX live viewer session" on public.video_library as restrictive
for all to authenticated using ((select streamx_private.current_user_exists()))
with check ((select streamx_private.current_user_exists()));
drop policy if exists "StreamX live viewer session" on public.library_activity;
create policy "StreamX live viewer session" on public.library_activity as restrictive
for all to authenticated using ((select streamx_private.current_user_exists()))
with check ((select streamx_private.current_user_exists()));

-- Guard existing privileged analytics/migration writes against deleted JWTs.
CREATE OR REPLACE FUNCTION public.claim_streamx_legacy_identity(p_legacy_like_user_id text DEFAULT NULL::text, p_legacy_viewer_id text DEFAULT NULL::text, p_platform text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
    current_user_id uuid := auth.uid();
    current_user_text text;
    legacy_like_id text;
    legacy_viewer_id text;
    copied_likes integer := 0;
    copied_saves integer := 0;
begin
    if not streamx_private.current_user_exists() then
        raise exception 'The viewer session has ended. Please reopen StreamX.' using errcode = '42501';
    end if;

    if current_user_id is null then
        raise exception 'Authentication required';
    end if;

    if p_platform not in ('website', 'mini_app') then
        raise exception 'Invalid platform';
    end if;

    current_user_text := current_user_id::text;
    legacy_like_id := nullif(left(btrim(coalesce(p_legacy_like_user_id, '')), 200), '');
    legacy_viewer_id := nullif(left(btrim(coalesce(p_legacy_viewer_id, '')), 200), '');

    -- Copy only. Never delete the legacy rows during the migration period.
    if legacy_like_id is not null
       and legacy_like_id <> current_user_text then

        insert into public.video_likes (video_id, user_id)
        select l.video_id, current_user_text
        from public.video_likes l
        where l.user_id::text = legacy_like_id
        on conflict do nothing;

        get diagnostics copied_likes = row_count;
    end if;

    if legacy_viewer_id is not null
       and legacy_viewer_id <> current_user_text then

        insert into public.video_library (viewer_id, platform, video_id)
        select current_user_text, p_platform, lib.video_id
        from public.video_library lib
        where lib.viewer_id = legacy_viewer_id
          and lib.platform = p_platform
        on conflict do nothing;

        get diagnostics copied_saves = row_count;
    end if;

    return jsonb_build_object(
        'user_id', current_user_text,
        'copied_likes', copied_likes,
        'copied_saves', copied_saves
    );
end;
$function$
;
CREATE OR REPLACE FUNCTION public.increment_video_views(p_video_id bigint)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
    current_user_id uuid;
    current_view_count bigint;
    cooldown_written boolean;
begin
    if not streamx_private.current_user_exists() then
        raise exception 'The viewer session has ended. Please reopen StreamX.' using errcode = '42501';
    end if;

    current_user_id := auth.uid();

    if current_user_id is null then
        raise exception 'Authentication required';
    end if;

    if p_video_id is null then
        raise exception 'A video ID is required';
    end if;

    -- Confirm the target exists and capture its current count.
    select coalesce(v.views, 0)::bigint
      into current_view_count
      from public.videos v
     where v.id = p_video_id;

    if not found then
        raise exception 'Video not found';
    end if;

    /*
     * The primary key serializes concurrent calls for the same
     * authenticated user + video pair.
     *
     * A row is inserted for a first view.
     * An existing row is refreshed only when its 5-minute cooldown expired.
     * If the cooldown is still active, RETURNING produces no row and the
     * videos.views value is not incremented.
     */
    cooldown_written := null;

    insert into public.video_view_cooldowns as current_cooldown (
        viewer_id,
        video_id,
        last_counted_at
    )
    values (
        current_user_id,
        p_video_id,
        now()
    )
    on conflict (viewer_id, video_id) do update
        set last_counted_at = excluded.last_counted_at
        where current_cooldown.last_counted_at
              <= now() - interval '5 minutes'
    returning true
      into cooldown_written;

    if coalesce(cooldown_written, false) then

        update public.videos
           set views = coalesce(views, 0) + 1
         where id = p_video_id
         returning views::bigint
          into current_view_count;

        if not found then
            raise exception 'Video not found';
        end if;

    else

        -- Another call during the cooldown does not increment anything.
        select coalesce(v.views, 0)::bigint
          into current_view_count
          from public.videos v
         where v.id = p_video_id;

    end if;

    return current_view_count;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.record_video_watch_time(p_session_id uuid, p_viewer_id text, p_video_id bigint, p_platform text, p_watched_seconds bigint)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
    current_user_id text;
    resolved_category text;
    saved_seconds bigint;
begin
    if not streamx_private.current_user_exists() then
        raise exception 'The viewer session has ended. Please reopen StreamX.' using errcode = '42501';
    end if;

    current_user_id := auth.uid()::text;

    if current_user_id is null or current_user_id = '' then
        raise exception 'Authentication required';
    end if;

    if p_session_id is null then
        raise exception 'A watch session ID is required';
    end if;

    if p_video_id is null then
        raise exception 'A video ID is required';
    end if;

    if p_platform not in ('website', 'mini_app') then
        raise exception 'Invalid platform';
    end if;

    if p_watched_seconds is null or p_watched_seconds < 1 then
        raise exception 'Invalid watched time';
    end if;

    select coalesce(nullif(btrim(v.category), ''), 'Uncategorized')
    into resolved_category
    from public.videos v
    where v.id = p_video_id;

    if not found then
        raise exception 'Video not found';
    end if;

    /*
     * p_viewer_id is intentionally ignored.
     * The authenticated Supabase UID is the only accepted viewer identity.
     *
     * The first heartbeat normally arrives around 10 seconds after playback
     * begins, so a new session may claim at most 15 seconds initially.
     * Afterwards the maximum accepted cumulative time is bounded by server
     * wall-clock time since the row was created, plus the same small tolerance.
     */
    insert into public.video_watch_sessions (
        session_id,
        viewer_id,
        video_id,
        video_category,
        platform,
        watched_seconds,
        created_at,
        updated_at
    )
    values (
        p_session_id,
        current_user_id,
        p_video_id,
        resolved_category,
        p_platform,
        least(p_watched_seconds, 15::bigint),
        now(),
        now()
    )
    on conflict (session_id) do update
    set watched_seconds = greatest(
            public.video_watch_sessions.watched_seconds,
            least(
                p_watched_seconds,
                greatest(
                    public.video_watch_sessions.watched_seconds,
                    floor(
                        extract(
                            epoch from (
                                now() - public.video_watch_sessions.created_at
                            )
                        )
                    )::bigint + 15
                )
            )
        ),
        video_category = resolved_category,
        updated_at = now()
    where public.video_watch_sessions.viewer_id = current_user_id
      and public.video_watch_sessions.video_id = p_video_id
      and public.video_watch_sessions.platform = p_platform
    returning watched_seconds into saved_seconds;

    if saved_seconds is null then
        raise exception 'Watch session details do not match the authenticated user';
    end if;

    return saved_seconds;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.record_viewer_time(p_session_id uuid, p_viewer_id text, p_platform text, p_context text, p_duration_seconds bigint, p_ended boolean DEFAULT false)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
    current_user_id text;
    saved_seconds bigint;
begin
    if not streamx_private.current_user_exists() then
        raise exception 'The viewer session has ended. Please reopen StreamX.' using errcode = '42501';
    end if;

    current_user_id := auth.uid()::text;

    if current_user_id is null or current_user_id = '' then
        raise exception 'Authentication required';
    end if;

    if p_session_id is null then
        raise exception 'A time-session ID is required';
    end if;

    if p_platform not in ('website', 'mini_app') then
        raise exception 'Invalid platform';
    end if;

    if p_context not in ('library', 'outside') then
        raise exception 'Invalid time-session context';
    end if;

    if p_duration_seconds is null or p_duration_seconds < 0 then
        raise exception 'Invalid duration';
    end if;

    /*
     * p_viewer_id is intentionally ignored.
     * The latest clients create visible-time sessions immediately, so server
     * elapsed time is a useful ceiling. A 5-second tolerance allows normal
     * network/authentication delay without permitting arbitrary values.
     */
    insert into public.viewer_time_sessions (
        session_id,
        viewer_id,
        platform,
        context,
        started_at,
        last_seen,
        ended_at,
        duration_seconds
    )
    values (
        p_session_id,
        current_user_id,
        p_platform,
        p_context,
        now(),
        now(),
        case when coalesce(p_ended, false) then now() else null end,
        least(p_duration_seconds, 5::bigint)
    )
    on conflict (session_id) do update
    set duration_seconds = greatest(
            public.viewer_time_sessions.duration_seconds,
            least(
                p_duration_seconds,
                greatest(
                    public.viewer_time_sessions.duration_seconds,
                    floor(
                        extract(
                            epoch from (
                                now() - public.viewer_time_sessions.started_at
                            )
                        )
                    )::bigint + 5
                )
            )
        ),
        last_seen = now(),
        ended_at = case
            when coalesce(p_ended, false)
                then coalesce(
                    public.viewer_time_sessions.ended_at,
                    now()
                )
            else public.viewer_time_sessions.ended_at
        end
    where public.viewer_time_sessions.viewer_id = current_user_id
      and public.viewer_time_sessions.platform = p_platform
      and public.viewer_time_sessions.context = p_context
    returning duration_seconds into saved_seconds;

    if saved_seconds is null then
        raise exception 'Time session details do not match the authenticated user';
    end if;

    return saved_seconds;
end;
$function$
;
