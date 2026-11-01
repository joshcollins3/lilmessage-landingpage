# Setting up Tabernacle, the forum

Until `forum/config.js` is filled in, `lilmessage.org/forum/` shows "Opening soon", so it's safe to deploy the site before doing this.

## 1. Create the database

1. Create a free project at [supabase.com](https://supabase.com). Save the database password somewhere safe.
2. Open **SQL Editor**, paste in all of [`schema.sql`](schema.sql), and click **Run**. Only run it once.

## 2. Connect the site

1. Open **Project Settings → API**. Copy the **Project URL** and the **anon public** key (it may be labelled "publishable").
2. Put them in `forum/config.js`, along with an email address people can use for removal requests. It's shown publicly on the rules page.

The anon key is meant to be public. Never put the `service_role` or `secret` key in this repo, because everything here is published.

## 3. Allow the sign-in links

Open **Authentication → URL Configuration** and set:

- **Site URL:** `https://lilmessage.org`
- **Redirect URLs:** `https://lilmessage.org/forum/**`

## 4. Set up email sending

Supabase's built-in email is only for trying things out and sends very few messages an hour, so real members won't be able to sign in reliably without this.

1. Sign up with an email service such as Resend or Postmark, and verify `lilmessage.org` with it.
2. Enter its SMTP details under **Authentication → SMTP Settings**.
3. Optional: reword the email under **Authentication → Email Templates → Magic Link**.

## 5. Make yourself the admin

Deploy the site, sign in at `lilmessage.org/forum/`, and choose a username. Then run this in the SQL Editor, using your own username:

```sql
update public.profiles set is_admin = true where username = 'your_username';
```

A **Moderate** link appears in the forum's top bar after you reload.

Names containing "lilmessage" are blocked at sign-up to stop impersonation. To use one yourself, set it here:

```sql
update public.profiles set username = 'LilMessage' where username = 'your_username';
```

## Good to know

- **Paused projects:** free Supabase projects pause after a period of inactivity. Check the current plan terms before you announce the forum.
- **Custom API domain:** the page only talks to `*.supabase.co`. If you ever give Supabase a custom domain, add it to `connect-src` in `forum/index.html`.
- **Changing the boards:** edit the `boards` table in the Supabase dashboard. Covers come from `forum/covers/`, so add a new album's image there and put its filename in the `cover` column.
- **Rate limits:** 5 new threads an hour, 10 replies every 10 minutes and 10 reports an hour, per person. They're set in `schema.sql`.
