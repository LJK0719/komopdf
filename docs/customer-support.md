# Komo customer support

Customer support is separate from the PDF assistant. The web launcher and desktop Help action open a compact panel for product questions, support requests and feedback. Chat uses the configured OpenAI-compatible model; it has no PDF tools and does not charge the document assistant's credit ledger.

Requests and replies are stored in a dedicated SQLite database. Signed-in users use the existing Clerk or desktop account session; guests use a separate random credential. Administrators are selected by server-side user IDs. `/admin/support/` provides the request list, replies, status updates and individual notification resend controls. Every API checks identity and ownership.

## Gateway configuration

Use service-native environment files or systemd credentials, outside the repository and release directories:

- `KOMO_SUPPORT_DB`: persistent SQLite path, for example `/var/lib/pdf-editor/support.sqlite`.
- `KOMO_SUPPORT_ADMIN_IDS`: comma-separated Clerk user IDs allowed to manage support.
- `ASSISTANT_LLM_BASE_URL`: OpenAI-compatible `/v1` base URL; default `https://gemini.openjk.space/v1`.
- `ASSISTANT_LLM_MODEL`: default `gemini-4-hydrogen-xhigh`.
- `ASSISTANT_LLM_API_KEY`: environment or same-named systemd credential.
- `SUPPORT_SMTP_HOST`, `SUPPORT_SMTP_PORT`, `SUPPORT_SMTP_USER`, `SUPPORT_SMTP_PASSWORD`.
- `SUPPORT_FROM_EMAIL`: SMTP-authorized sender.
- `SUPPORT_TO_EMAIL`: support inbox.

The gateway service needs write access to the support database's parent directory. The account and billing database remains separate. Add the `/api/support` proxy block from the Nginx example when enabling the feature.

## Messages and notifications

The API persists a request or reply before sending notifications. New requests and customer additions notify the support inbox; submission acknowledgements and staff replies notify the customer's supplied email. Customer notifications contain a reference and link to Help; the request body and reply remain behind the original user/guest identity. Emails do not grant ticket access. Email replies are not imported; staff respond through the support desk.

Notification delivery is recorded per message. A failed notification can be resent by an administrator without recreating the request or resending an already accepted notification. The UI supports the same language set as the editor. Chat stays in the current panel; users choose whether to attach its transcript to a request.

## Checks

`pnpm exec vitest run apps/gateway/test/support.test.ts` covers guest isolation, admin authorization, the reply/status flow, deduplication, email failure/resend, feedback, and native guest sessions. Web and desktop share the panel through the editor package's dedicated `support-*` exports.
