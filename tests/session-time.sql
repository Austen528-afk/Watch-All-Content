-- Run through an authorized database connection after setup_admin_session_time.sql.
-- All fixtures are rolled back; no accounts, media or existing activity change.
begin;
do $test$
declare
    viewer uuid;
    other_viewer uuid;
    admin_id uuid;
    visit_one uuid := gen_random_uuid();
    visit_two uuid := gen_random_uuid();
    segment_one uuid := gen_random_uuid();
    segment_two uuid := gen_random_uuid();
    segment_three uuid := gen_random_uuid();
    before_metrics jsonb;
    after_metrics jsonb;
    saved bigint;
begin
    select id into viewer from auth.users where is_anonymous order by created_at limit 1;
    select id into other_viewer from auth.users where is_anonymous and id <> viewer order by created_at limit 1;
    select user_id into admin_id from public.streamx_admins limit 1;
    assert viewer is not null and other_viewer is not null and admin_id is not null, 'Existing test identities required';

    perform set_config('request.jwt.claim.sub', admin_id::text, true);
    select u into before_metrics from jsonb_array_elements(public.get_streamx_admin_viewers(0,50)->'users') u
        where u->>'viewer_id' = viewer::text;

    perform set_config('request.jwt.claim.sub', viewer::text, true);
    begin
        perform public.get_streamx_admin_viewers(0,50);
        raise exception 'Non-admin could read individual metrics';
    exception when insufficient_privilege then null;
    end;

    saved := public.record_viewer_visit_time(segment_one,visit_one,other_viewer::text,'website','outside',999999,false);
    assert saved = 5, 'The existing duration cap must apply';
    assert (select viewer_id = viewer::text from public.viewer_time_sessions where session_id = segment_one), 'Viewer identity must come from Auth';
    perform public.record_viewer_visit_time(segment_two,visit_one,viewer::text,'website','library',0,true);
    perform public.record_viewer_visit_time(segment_three,visit_two,viewer::text,'website','outside',0,true);
    update public.viewer_time_sessions set duration_seconds = case session_id
        when segment_one then 60 when segment_two then 30 else 120 end
        where session_id in (segment_one,segment_two,segment_three);

    begin
        perform public.record_viewer_visit_time(segment_one,visit_two,viewer::text,'website','outside',0,false);
        raise exception 'A segment could change visits';
    exception when insufficient_privilege then null;
    end;

    perform set_config('request.jwt.claim.sub', other_viewer::text, true);
    begin
        perform public.record_viewer_visit_time(segment_one,visit_one,viewer::text,'website','outside',0,false);
        raise exception 'Another viewer could update the segment';
    exception when sqlstate 'P0001' then
        if sqlerrm <> 'Time session details do not match the authenticated user' then raise; end if;
    end;

    perform set_config('request.jwt.claim.sub', '', true);
    begin
        perform public.record_viewer_visit_time(gen_random_uuid(),visit_one,viewer::text,'website','outside',0,false);
        raise exception 'A missing Auth identity could write';
    exception when insufficient_privilege then null;
    end;

    -- Three adjacent legacy context segments are one estimated visit. A later
    -- outside segment is a separate visit, even though the context matches.
    insert into public.viewer_time_sessions(session_id,viewer_id,platform,context,started_at,last_seen,ended_at,duration_seconds)
    values
        (gen_random_uuid(),viewer::text,'website','outside','2000-01-01 00:00:00+00','2000-01-01 00:00:04+00','2000-01-01 00:00:04+00',4),
        (gen_random_uuid(),viewer::text,'website','library','2000-01-01 00:00:04+00','2000-01-01 00:00:09+00','2000-01-01 00:00:09+00',5),
        (gen_random_uuid(),viewer::text,'website','outside','2000-01-01 00:00:09+00','2000-01-01 00:00:15+00','2000-01-01 00:00:15+00',6),
        (gen_random_uuid(),viewer::text,'website','outside','2000-01-01 00:02:00+00','2000-01-01 00:02:07+00','2000-01-01 00:02:07+00',7);

    perform set_config('request.jwt.claim.sub', admin_id::text, true);
    select u into after_metrics from jsonb_array_elements(public.get_streamx_admin_viewers(0,50)->'users') u
        where u->>'viewer_id' = viewer::text;
    assert (after_metrics->>'session_count')::bigint = (before_metrics->>'session_count')::bigint + 4, 'Context segments must not inflate the visit count';
    assert (after_metrics->>'total_session_seconds')::numeric = (before_metrics->>'total_session_seconds')::numeric + 232, 'All recorded durations must contribute exactly once';
    assert (after_metrics->>'estimated_session_count')::bigint = (before_metrics->>'estimated_session_count')::bigint + 2, 'Historical estimates must be labelled';
    assert abs((after_metrics->>'average_session_seconds')::numeric -
        (after_metrics->>'total_session_seconds')::numeric / (after_metrics->>'session_count')::numeric) < 0.00001, 'Average must be total time divided by visits';

    assert not has_function_privilege('anon','public.record_viewer_visit_time(uuid,uuid,text,text,text,bigint,boolean)','execute'), 'Anonymous API keys cannot write';
    assert has_function_privilege('authenticated','public.record_viewer_visit_time(uuid,uuid,text,text,text,bigint,boolean)','execute'), 'Authenticated clients can record their own visits';
    assert (select relrowsecurity from pg_class where oid='public.viewer_time_sessions'::regclass), 'Session RLS must remain enabled';
end;
$test$;
rollback;
select 'Session grouping, average calculation and authorization checks passed; fixtures rolled back.' as result;
