# Research access

The landing page (`landing/index.html`, `/landing/` on the dev server) is public.
The simulator asks researchers to sign in first. This page sets that up.

Sign-in uses [Supabase Auth](https://supabase.com/docs/guides/auth) (email and
password, email confirmation, password reset). The landing page stays public;
the simulator is only built after a session exists.

1. **Keys.** Copy `.env.example` to `.env.local` and fill in the project URL
   and the public **anon** key (Supabase → Project Settings → API). Never use
   the service-role key: anything prefixed `VITE_` ships to the browser, and
   the app refuses to start with a secret key.
2. **Database.** Apply `supabase/migrations/` (Supabase → SQL Editor, paste the
   file and run it; or `supabase link` then `supabase db push`). It creates
   `public.profiles`, a trigger that gives every new user a profile, and
   owner-only row level security.
3. **Redirects.** Supabase → Authentication → URL Configuration: set the Site
   URL to where the simulator is hosted, and add `http://localhost:5173/**`
   (plus the hosted URL with `/**`) to Redirect URLs, so confirmation and reset
   emails can return to the app.
4. **Password policy.** Authentication → Providers → Email: set the minimum
   password length to 8 to match the form. "Confirm email" may be on or off;
   both paths are handled.

## Sign in with ORCID

Researchers can also sign in with their [ORCID iD](https://orcid.org). There is
no separate registration: the first ORCID sign-in creates the account. Supabase
runs the OpenID Connect exchange and verifies ORCID's signed token; a database
trigger then records the iD on the profile with `orcid_verified_at`. Nobody can
type an iD in or mark themselves verified, so a verified iD always means ORCID
authenticated that person. ORCID never shares an email, so these accounts show
the researcher's name and a link to their ORCID record instead.

1. Create ORCID public API credentials at <https://orcid.org/developer-tools>
   with the redirect URI `https://<project-ref>.supabase.co/auth/v1/callback`.
2. Enable custom OAuth providers for the project in the Supabase dashboard
   (Authentication → Sign In / Providers).
3. Register the provider, from your own machine (the service-role key stays there):

   ```
   SUPABASE_URL=https://<project-ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=… \
   ORCID_CLIENT_ID=APP-… ORCID_CLIENT_SECRET=… npm run setup:orcid
   ```

4. Set `VITE_ORCID_ENABLED=true` in `.env.local`. Until then the button is hidden.

The sign-in screen is the experience, not the security boundary: the static
simulator files are served to anyone. Anything that must stay private belongs
in Supabase behind row level security, as `profiles` does.

