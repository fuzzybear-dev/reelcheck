# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report privately through GitHub: go to the **Security** tab of this repository and choose
**Report a vulnerability**. You will get a reply within a few days. Please include the steps to
reproduce, the affected version or commit, and the impact you expect.

## Supported versions

Only the latest commit on `main` receives security fixes.

## Deployment notes

ReelCheck is meant to run behind your own gateway. Before exposing it:

- **Authentication.** The API has no built-in authentication. Anyone who can reach it can submit
  videos (which spends model credits) and read any job whose ID they know. Put it behind an
  authenticating proxy or private network.
- **Allowlists.** `ALLOWED_VIDEO_HOSTS` and `ALLOWED_CALLBACK_HOSTS` are empty by default, which
  rejects every URL. Set them to the exact hosts you control.
- **Proxies.** Set `TRUST_PROXY=1` only when a reverse proxy you control appends `X-Forwarded-For`;
  otherwise clients can spoof their address and evade rate limits.
- **Secrets.** Keep `GEMINI_API_KEY` in `.env` or your secret manager. `.env` is gitignored.
- **Untrusted media.** Videos are decoded with ffmpeg. Run the service in a container or sandbox
  with no access to internal networks it does not need, and keep ffmpeg up to date.
