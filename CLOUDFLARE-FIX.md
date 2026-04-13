# Cloudflare Fix

If Cloudflare shows `HTTP 403` or `Authentication error`, do this:

1. Open https://dash.cloudflare.com and switch to the exact account you want to use.
2. Copy that account's Account ID.
3. Create a new API token using the Workers AI template, or give the token Workers AI account permissions for that same account.
4. In `.env`, set:

```env
CLOUDFLARE_ENABLED=true
CLOUDFLARE_ACCOUNT_ID=your-real-account-id
CLOUDFLARE_API_TOKEN=your-new-workers-ai-token
```

5. Leave `CLOUDFLARE_GATEWAY_NAME` blank unless you intentionally use Cloudflare AI Gateway.
6. Restart the hub.
7. Test Cloudflare again in the dashboard.

What this usually means:
- The token is wrong for that account, or
- the Account ID is from a different Cloudflare account, or
- the token does not have Workers AI permission.

What it usually does **not** mean:
- It is usually not a bug in this repo.
- You usually do not need AI Gateway to make Cloudflare work.

Fastest fix:
- Regenerate the token on the correct Cloudflare account, copy the matching Account ID, save both into `.env`, restart.