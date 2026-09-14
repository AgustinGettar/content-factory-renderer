begin;

-- The renderer uses the service role. Browser clients do not need direct
-- access to Lumi's character profile or to these orchestration views.
alter table public.characters enable row level security;
revoke all privileges on table public.characters from anon, authenticated;

alter view public.scene_generation_context set (security_invoker = true);
alter view public.video_render_readiness set (security_invoker = true);
revoke all privileges on table public.scene_generation_context from anon, authenticated;
revoke all privileges on table public.video_render_readiness from anon, authenticated;

commit;
