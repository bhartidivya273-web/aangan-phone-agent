-- Applied to the live project as "harden_trigger_and_api_roles".
alter function public.prevent_protected_call_delete() set search_path = public;

-- Only the server (service role) touches this data. RLS already denies the public API roles; this removes their grants too.
revoke all on table public.leads, public.calls, public.handoffs, public.costs from anon, authenticated;
