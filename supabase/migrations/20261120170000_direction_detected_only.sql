-- Direction is no longer chosen at upload: processing always detects it from
-- the Company's identity, and the User sets it in the Document detail when
-- detection fails. Existing preselections stay as historical upload intent in
-- exports, but nobody can record a new one.

revoke insert (preselected_direction) on public.source_file from authenticated;
