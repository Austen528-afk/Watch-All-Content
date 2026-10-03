-- StreamX security hardening. Preserves existing accounts, videos and engagement.
-- Run after the existing StreamX setup scripts.

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "allow all users" ON public.users;
DROP POLICY IF EXISTS "StreamX users select" ON public.users;
DROP POLICY IF EXISTS "StreamX users insert" ON public.users;
DROP POLICY IF EXISTS "StreamX users update" ON public.users;
DROP POLICY IF EXISTS "StreamX legacy users admin access" ON public.users;
DROP POLICY IF EXISTS "StreamX legacy users admin guard" ON public.users;

-- The current clients use Supabase Auth, not this legacy Telegram profile table.
-- Keep legacy profiles available to the admin inventory and reset functions.
REVOKE ALL ON TABLE public.users FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.users TO authenticated;

CREATE POLICY "StreamX legacy users admin access"
ON public.users FOR ALL TO authenticated
USING ((SELECT public.is_streamx_admin()))
WITH CHECK ((SELECT public.is_streamx_admin()));

-- A restrictive guard also protects against an old permissive setup policy.
CREATE POLICY "StreamX legacy users admin guard"
ON public.users AS RESTRICTIVE FOR ALL TO anon, authenticated
USING ((SELECT public.is_streamx_admin()))
WITH CHECK ((SELECT public.is_streamx_admin()));

CREATE OR REPLACE FUNCTION public.claim_streamx_legacy_identity(
    p_legacy_like_user_id text DEFAULT NULL::text,
    p_legacy_viewer_id text DEFAULT NULL::text,
    p_platform text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $function$
DECLARE
    current_user_id uuid := auth.uid();
BEGIN
    IF current_user_id IS NULL OR NOT streamx_private.current_user_exists() THEN
        RAISE EXCEPTION 'The viewer session has ended. Please reopen StreamX.'
            USING errcode = '42501';
    END IF;

    IF p_platform IS NULL OR p_platform NOT IN ('website', 'mini_app') THEN
        RAISE EXCEPTION 'Invalid platform' USING errcode = '22023';
    END IF;

    -- Raw legacy IDs are not proof of ownership. Never copy another identity's
    -- likes or library. Keep this startup RPC and response compatible with the
    -- existing clients; all previously migrated and current account data stays.
    RETURN jsonb_build_object(
        'user_id', current_user_id::text,
        'copied_likes', 0,
        'copied_saves', 0
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_streamx_legacy_identity(text, text, text)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_streamx_legacy_identity(text, text, text)
TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_active_users()
RETURNS bigint
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $function$
BEGIN
    IF NOT public.is_streamx_admin() THEN
        RAISE EXCEPTION 'Admin access required' USING errcode = '42501';
    END IF;

    RETURN (
        SELECT count(*) FROM public.active_users
        WHERE last_seen > now() - interval '60 seconds'
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_active_users() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_active_users() TO authenticated;

CREATE OR REPLACE FUNCTION public.increment_likes(video_id_input bigint)
RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path TO ''
AS $function$
    UPDATE public.videos
    SET likes_count = likes_count + 1
    WHERE id = video_id_input;
$function$;

CREATE OR REPLACE FUNCTION public.decrement_likes(video_id_input bigint)
RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path TO ''
AS $function$
    UPDATE public.videos
    SET likes_count = greatest(likes_count - 1, 0)
    WHERE id = video_id_input;
$function$;

REVOKE ALL ON FUNCTION public.increment_likes(bigint), public.decrement_likes(bigint)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.increment_likes(bigint), public.decrement_likes(bigint)
TO authenticated, service_role;

-- Only the existing database trigger should execute this privileged function.
-- Trigger execution continues to work without exposing a client-callable RPC.
REVOKE ALL ON FUNCTION public.capture_library_save_event()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.capture_library_save_event() TO service_role;
