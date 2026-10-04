# Security

## Reporting a problem

Please report vulnerabilities privately through
[GitHub security advisories](https://github.com/SborJ/Iressa/security/advisories/new),
not in a public issue. Say what you found, how to reproduce it and what it
exposes. You should hear back within a week.

## What is in scope

- The sign-in flow in `src/auth/` and the database schema and row level
  security policies in `supabase/migrations/`.
- The server's `/api/ai/*` endpoints in `vite.config.ts`, which start a
  Python training process on the host.
- Anything that would leak a key or a researcher's profile data.

## What to know before reporting

- The sign-in screen is the experience, not the security boundary. The
  simulator's static files are served to anyone; that is by design. Data that
  must stay private lives in Supabase behind row level security.
- Only the public **anon** key belongs in a `VITE_` variable. The app refuses
  to start with a service-role key. If you find a secret committed to this
  repository, that is a valid report.
- `/api/ai/*` is not behind sign-in. It accepts only a cancer id from a fixed
  list and a duration, runs one trainer at a time and caps each at two
  minutes. A way to make it run anything else, or to exhaust the host, is a
  valid report.
