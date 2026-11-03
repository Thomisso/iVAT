# Internal Supabase transport preserves its public identity

Production server-side Supabase HTTP communication uses the gateway inside the stack instead of the public Supabase address, so communication between colocated services does not depend on public DNS and external TLS routing. This follows the QA v6 incident in which the production resolver returned an endpoint with an invalid certificate while the internal gateway remained available.

The public Supabase URL remains the identity used for browser access, OAuth, email links and file links, and existing authentication cookies remain compatible. Separating transport from public identity requires explicit handling of generated URLs and SDK defaults; replacing the base URL globally would change those guarantees.

If the internal gateway is unavailable, server requests report temporary unavailability rather than automatically falling back to the public endpoint. This keeps the failed internal dependency visible and avoids reintroducing the public DNS/TLS path that caused the incident; dependency availability is reported separately from web-process liveness, without mass logout or restarting an otherwise healthy web process.
