-- Recommendation update:
-- * Measure category watch-time share over the last 90 days, falling back to all recorded time.
-- * Give that watched-category profile more influence than likes/saves.
-- * Reserve up to two recommendation slots for uploads from the last 14 days.
--   For established viewers, those slots come from their three strongest categories.
--   For viewers with no history, they provide a small newest-upload discovery mix.
-- * Preserve the existing RPC signature so both StreamX clients continue calling it.

CREATE OR REPLACE FUNCTION public.get_streamx_recommendations(
    p_viewer_id text,
    p_platform text,
    p_like_user_id text DEFAULT NULL::text,
    p_limit integer DEFAULT 8,
    p_trigger_video_id bigint DEFAULT NULL::bigint,
    p_exclude_video_ids bigint[] DEFAULT NULL::bigint[]
)
RETURNS TABLE(
    video_id bigint,
    title text,
    description text,
    category text,
    video_url text,
    thumbnail_url text,
    created_at timestamp with time zone,
    views bigint,
    likes_count bigint,
    recommendation_score numeric,
    recommendation_mode text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    requested_limit integer;
    current_user_id text;
BEGIN
    current_user_id := auth.uid()::text;

    IF current_user_id IS NULL OR current_user_id = '' THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    IF p_platform IS NULL OR p_platform NOT IN ('website', 'mini_app') THEN
        RAISE EXCEPTION 'Invalid platform';
    END IF;

    requested_limit := LEAST(
        GREATEST(COALESCE(p_limit, 8), 1),
        12
    );

    RETURN QUERY
    WITH params AS (
        SELECT
            current_user_id AS viewer_id,
            p_platform AS platform,
            current_user_id AS like_user_id,
            p_trigger_video_id::bigint AS trigger_video_id,
            COALESCE(p_exclude_video_ids, '{}'::bigint[]) AS exclude_ids,
            requested_limit AS requested_limit,
            LEAST(2, GREATEST(1, (requested_limit + 3) / 4)) AS fresh_slots
    ),
    global_likes AS (
        SELECT
            l.video_id,
            COUNT(*)::bigint AS likes_count
        FROM public.video_likes l
        GROUP BY l.video_id
    ),
    global_watch AS (
        SELECT
            s.video_id::bigint AS video_id,
            SUM(GREATEST(COALESCE(s.watched_seconds, 0), 0))::numeric AS watch_seconds
        FROM public.video_watch_sessions s
        JOIN params p
            ON p.platform = s.platform
        WHERE s.video_id IS NOT NULL
        GROUP BY s.video_id
    ),
    catalog AS (
        SELECT
            v.id::bigint AS video_id,
            COALESCE(NULLIF(BTRIM(v.title), ''), 'Untitled Video')::text AS title,
            v.description::text AS description,
            COALESCE(NULLIF(BTRIM(v.category), ''), 'Uncategorized')::text AS category,
            v.video_url::text AS video_url,
            v.thumbnail_url::text AS thumbnail_url,
            v.created_at::timestamptz AS created_at,
            GREATEST(COALESCE(v.views, 0), 0)::bigint AS views,
            COALESCE(gl.likes_count, 0)::bigint AS likes_count,
            COALESCE(gw.watch_seconds, 0)::numeric AS watch_seconds
        FROM public.videos v
        LEFT JOIN global_likes gl
            ON gl.video_id = v.id
        LEFT JOIN global_watch gw
            ON gw.video_id = v.id
        WHERE NULLIF(BTRIM(v.video_url), '') IS NOT NULL
    ),
    seed AS (
        SELECT c.category AS seed_category
        FROM params p
        LEFT JOIN catalog c
            ON p.trigger_video_id = c.video_id
    ),
    user_watch AS (
        SELECT
            s.video_id::bigint AS video_id,
            SUM(GREATEST(COALESCE(s.watched_seconds, 0), 0))::numeric AS watch_seconds,
            COALESCE(
                SUM(GREATEST(COALESCE(s.watched_seconds, 0), 0)) FILTER (
                    WHERE COALESCE(s.updated_at, s.created_at)
                        >= NOW() - INTERVAL '90 days'
                ),
                0
            )::numeric AS recent_watch_seconds,
            MAX(
                COALESCE(
                    NULLIF(BTRIM(v.category), ''),
                    NULLIF(BTRIM(s.video_category), ''),
                    'Uncategorized'
                )
            )::text AS category
        FROM public.video_watch_sessions s
        JOIN params p
            ON p.viewer_id = s.viewer_id
           AND p.platform = s.platform
        LEFT JOIN public.videos v
            ON v.id = s.video_id
        WHERE s.video_id IS NOT NULL
        GROUP BY s.video_id
    ),
    user_saved AS (
        SELECT l.video_id::bigint AS video_id
        FROM public.video_library l
        JOIN params p
            ON p.viewer_id = l.viewer_id
           AND p.platform = l.platform
        GROUP BY l.video_id
    ),
    user_liked AS (
        SELECT l.video_id::bigint AS video_id
        FROM public.video_likes l
        JOIN params p
            ON p.like_user_id IS NOT NULL
           AND p.like_user_id = l.user_id::text
        GROUP BY l.video_id
    ),
    user_category_watch AS (
        SELECT
            LOWER(uw.category) AS category_key,
            SUM(uw.watch_seconds)::numeric AS all_time_watch_seconds,
            SUM(uw.recent_watch_seconds)::numeric AS recent_watch_seconds
        FROM user_watch uw
        GROUP BY LOWER(uw.category)
    ),
    recent_watch_total AS (
        SELECT COALESCE(SUM(ucw.recent_watch_seconds), 0)::numeric AS watch_seconds
        FROM user_category_watch ucw
    ),
    category_watch_profile AS (
        SELECT
            ucw.category_key,
            CASE
                WHEN rwt.watch_seconds > 0 THEN ucw.recent_watch_seconds
                ELSE ucw.all_time_watch_seconds
            END::numeric AS watch_seconds
        FROM user_category_watch ucw
        CROSS JOIN recent_watch_total rwt
    ),
    category_signal_rows AS (
        SELECT
            cwp.category_key,
            cwp.watch_seconds AS signal,
            cwp.watch_seconds
        FROM category_watch_profile cwp

        UNION ALL

        SELECT
            LOWER(c.category) AS category_key,
            60::numeric AS signal,
            0::numeric AS watch_seconds
        FROM user_saved us
        JOIN catalog c
            ON c.video_id = us.video_id

        UNION ALL

        SELECT
            LOWER(c.category) AS category_key,
            40::numeric AS signal,
            0::numeric AS watch_seconds
        FROM user_liked ul
        JOIN catalog c
            ON c.video_id = ul.video_id
    ),
    user_category_interest AS (
        SELECT
            signals.category_key,
            SUM(signals.watch_seconds)::numeric AS watch_seconds,
            SUM(signals.signal)::numeric AS signal
        FROM category_signal_rows signals
        GROUP BY signals.category_key
    ),
    category_totals AS (
        SELECT
            uci.*,
            SUM(uci.watch_seconds) OVER ()::numeric AS total_watch_seconds,
            SUM(uci.signal) OVER ()::numeric AS total_signal
        FROM user_category_interest uci
    ),
    category_profile AS (
        SELECT
            ct.category_key,
            ct.watch_seconds,
            ct.signal,
            CASE
                WHEN ct.total_watch_seconds > 0
                    THEN ct.watch_seconds / ct.total_watch_seconds
                WHEN ct.total_signal > 0
                    THEN ct.signal / ct.total_signal
                ELSE 0::numeric
            END::numeric AS preference_share,
            ROW_NUMBER() OVER (
                ORDER BY
                    CASE
                        WHEN ct.total_watch_seconds > 0 THEN ct.watch_seconds
                        ELSE ct.signal
                    END DESC,
                    ct.signal DESC,
                    ct.category_key ASC
            ) AS preference_rank
        FROM category_totals ct
    ),
    history AS (
        SELECT
            EXISTS (SELECT 1 FROM user_watch)
            OR EXISTS (SELECT 1 FROM user_saved)
            OR EXISTS (SELECT 1 FROM user_liked) AS has_history
    ),
    maxima AS (
        SELECT
            GREATEST(
                COALESCE((SELECT MAX(LN(1 + c.views::numeric)) FROM catalog c), 0),
                1
            )::numeric AS max_log_views,
            GREATEST(
                COALESCE((SELECT MAX(LN(1 + c.likes_count::numeric)) FROM catalog c), 0),
                1
            )::numeric AS max_log_likes,
            GREATEST(
                COALESCE(
                    (
                        SELECT MAX((c.likes_count + 1)::numeric / (c.views + 20)::numeric)
                        FROM catalog c
                    ),
                    0.0001
                ),
                0.0001
            )::numeric AS max_like_rate,
            GREATEST(
                COALESCE((SELECT MAX(LN(1 + c.watch_seconds)) FROM catalog c), 0),
                1
            )::numeric AS max_global_watch,
            GREATEST(
                COALESCE((SELECT MAX(uw.watch_seconds) FROM user_watch uw), 0),
                1
            )::numeric AS max_video_watch,
            GREATEST(
                COALESCE((SELECT MAX(cp.signal) FROM category_profile cp), 0),
                1
            )::numeric AS max_category_signal,
            GREATEST(
                COALESCE(
                    (
                        SELECT MAX(cp.signal - cp.watch_seconds)
                        FROM category_profile cp
                    ),
                    0
                ),
                1
            )::numeric AS max_nonwatch_category_signal,
            COALESCE(
                (SELECT SUM(cp.watch_seconds) FROM category_profile cp),
                0
            )::numeric AS total_user_watch_seconds
    ),
    scored AS (
        SELECT
            c.*,
            h.has_history,
            seed.seed_category,
            cp.preference_rank,
            cp.preference_share,
            CASE
                WHEN NOT h.has_history THEN
                    (LN(1 + c.views::numeric) / m.max_log_views) * 60
                    + (LN(1 + c.likes_count::numeric) / m.max_log_likes) * 40
                    + CASE
                        WHEN seed.seed_category IS NOT NULL
                         AND LOWER(c.category) = LOWER(seed.seed_category)
                            THEN 5
                        ELSE 0
                      END
                    + CASE
                        WHEN c.created_at >= NOW() - INTERVAL '14 days'
                            THEN GREATEST(
                                0::numeric,
                                1::numeric -
                                (
                                    GREATEST(
                                        EXTRACT(EPOCH FROM (NOW() - c.created_at)),
                                        0
                                    )::numeric / 1209600::numeric
                                )
                            ) * 20::numeric
                        ELSE 0
                      END
                ELSE
                    COALESCE(uw.watch_seconds, 0) / m.max_video_watch * 30
                    + CASE
                        WHEN m.total_user_watch_seconds > 0
                            THEN COALESCE(cp.watch_seconds, 0)
                                 / m.total_user_watch_seconds * 30
                        ELSE COALESCE(cp.signal, 0)
                             / m.max_category_signal * 30
                      END
                    + GREATEST(
                        COALESCE(cp.signal - cp.watch_seconds, 0),
                        0
                      ) / m.max_nonwatch_category_signal * 5
                    + CASE
                        WHEN seed.seed_category IS NOT NULL
                         AND LOWER(c.category) = LOWER(seed.seed_category)
                            THEN 25
                        ELSE 0
                      END
                    + (LN(1 + c.views::numeric) / m.max_log_views) * 15
                    + (
                        (
                            (c.likes_count + 1)::numeric
                            / (c.views + 20)::numeric
                        ) / m.max_like_rate
                      ) * 10
                    + (LN(1 + c.watch_seconds) / m.max_global_watch) * 5
                    + CASE
                        WHEN c.created_at >= NOW() - INTERVAL '14 days'
                            THEN GREATEST(
                                0::numeric,
                                1::numeric -
                                (
                                    GREATEST(
                                        EXTRACT(EPOCH FROM (NOW() - c.created_at)),
                                        0
                                    )::numeric / 1209600::numeric
                                )
                            ) * 20::numeric
                        ELSE 0
                      END
                    + CASE
                        WHEN uw.video_id IS NULL
                         AND us.video_id IS NULL
                         AND ul.video_id IS NULL
                            THEN 8
                        ELSE -12
                      END
            END::numeric AS recommendation_score
        FROM catalog c
        CROSS JOIN maxima m
        CROSS JOIN history h
        CROSS JOIN seed
        LEFT JOIN user_watch uw
            ON uw.video_id = c.video_id
        LEFT JOIN user_saved us
            ON us.video_id = c.video_id
        LEFT JOIN user_liked ul
            ON ul.video_id = c.video_id
        LEFT JOIN category_profile cp
            ON cp.category_key = LOWER(c.category)
    ),
    eligible AS (
        SELECT s.*
        FROM scored s
        CROSS JOIN params p
        WHERE (p.trigger_video_id IS NULL OR s.video_id <> p.trigger_video_id)
          AND s.video_id <> ALL(p.exclude_ids)
    ),
    fresh_ranked AS (
        SELECT
            e.video_id,
            ROW_NUMBER() OVER (
                ORDER BY
                    COALESCE(cp.preference_share, 0) DESC,
                    e.recommendation_score DESC,
                    e.created_at DESC NULLS LAST,
                    e.video_id DESC
            ) AS fresh_rank
        FROM eligible e
        LEFT JOIN category_profile cp
            ON cp.category_key = LOWER(e.category)
        WHERE e.created_at >= NOW() - INTERVAL '14 days'
          AND (
                NOT e.has_history
                OR cp.preference_rank <= 3
          )
    ),
    fresh_picks AS (
        SELECT
            e.*,
            fr.fresh_rank::bigint AS selection_rank,
            CASE
                WHEN e.has_history THEN 'new_for_you'
                ELSE 'new_discovery'
            END::text AS recommendation_mode
        FROM eligible e
        JOIN fresh_ranked fr
            ON fr.video_id = e.video_id
        CROSS JOIN params p
        WHERE fr.fresh_rank <= p.fresh_slots
    ),
    regular_ranked AS (
        SELECT
            e.*,
            ROW_NUMBER() OVER (
                ORDER BY
                    e.recommendation_score DESC,
                    e.created_at DESC NULLS LAST,
                    e.video_id DESC
            ) AS regular_rank
        FROM eligible e
        WHERE NOT EXISTS (
            SELECT 1
            FROM fresh_picks fp
            WHERE fp.video_id = e.video_id
        )
    ),
    regular_picks AS (
        SELECT
            r.*,
            (
                (SELECT COUNT(*) FROM fresh_picks)
                + r.regular_rank
            )::bigint AS selection_rank,
            CASE
                WHEN NOT r.has_history THEN 'popular'
                WHEN r.seed_category IS NOT NULL
                 AND LOWER(r.category) = LOWER(r.seed_category)
                    THEN 'similar'
                ELSE 'personalized'
            END::text AS recommendation_mode
        FROM regular_ranked r
        CROSS JOIN params p
        WHERE r.regular_rank <=
            p.requested_limit - (SELECT COUNT(*) FROM fresh_picks)
    ),
    final_rows AS (
        SELECT
            fp.video_id,
            fp.title,
            fp.description,
            fp.category,
            fp.video_url,
            fp.thumbnail_url,
            fp.created_at,
            fp.views,
            fp.likes_count,
            fp.recommendation_score,
            fp.selection_rank,
            fp.recommendation_mode
        FROM fresh_picks fp

        UNION ALL

        SELECT
            rp.video_id,
            rp.title,
            rp.description,
            rp.category,
            rp.video_url,
            rp.thumbnail_url,
            rp.created_at,
            rp.views,
            rp.likes_count,
            rp.recommendation_score,
            rp.selection_rank,
            rp.recommendation_mode
        FROM regular_picks rp
    )
    SELECT
        f.video_id,
        f.title,
        f.description,
        f.category,
        f.video_url,
        f.thumbnail_url,
        f.created_at,
        f.views,
        f.likes_count,
        ROUND(f.recommendation_score, 4),
        f.recommendation_mode
    FROM final_rows f
    ORDER BY f.selection_rank;
END;
$function$;
