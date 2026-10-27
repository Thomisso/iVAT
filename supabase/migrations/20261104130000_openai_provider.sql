-- OpenAI provider and the safe provider list used by Company consent (#29).
-- API keys remain visible only through the existing worker-only resolver.

insert into public.platform_ai_provider (provider, split_model, extract_model)
values ('openai', 'gpt-4.1', 'gpt-4.1');

create function public.list_available_ai_providers()
returns table (provider text, region text)
language sql stable security definer set search_path = ''
as $$
  select p.provider, 'global'::text
  from public.platform_ai_provider p
  where p.available
  order by p.provider;
$$;

revoke execute on function public.list_available_ai_providers() from public, anon;
grant execute on function public.list_available_ai_providers() to authenticated;
